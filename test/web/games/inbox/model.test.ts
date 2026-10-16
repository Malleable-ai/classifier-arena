import { describe, expect, it } from 'vitest';
import type { Seat } from '../../../../src/core/classifier/types.js';
import type { DecisionLine, EventLine } from '../../../../src/core/log/schema.js';
import { stepInbox } from '../../../../src/games/inbox/engine/sim.js';
import type { InboxState } from '../../../../src/games/inbox/engine/types.js';
import {
  accuracyPct,
  bannerText,
  CARD_H,
  CARD_LINE_H,
  CARD_LINES,
  MESSAGE_MAX_PX,
  MESSAGE_PX,
  messageLayout,
  CARD_TOP_LAND,
  CARD_TOP_START,
  CARD_W,
  accuracyTexts,
  BANNER_BAND,
  CARD_PAD_X,
  cardPose,
  cardTop,
  COVER_ABOVE,
  COVER_BELOW,
  FADE_TICKS,
  HEADER_ROW,
  headerLabels,
  healthDigits,
  ENTER_TICKS,
  fallProgress,
  FLASH_TICKS,
  formatClock,
  holding,
  inboxRect,
  LAND_HOLD,
  LAND_TICKS,
  LANE_TOP,
  LANE_W,
  LANE_X,
  laneCards,
  laneRect,
  laneResolutions,
  lastHit,
  optionLabel,
  pulseAt,
  PULSE_TICKS,
  RESOLVE_HOLD,
  RESOLVE_TICKS,
  rowVisible,
  seatLabel,
  SWIPE_TEXT_FADE,
  textRow,
  STAGE_H,
  STAGE_W,
  wrapText,
  type LaneCard,
} from '../../../../src/web/games/inbox/model.js';
import { answer, itemAt, runTo, small, wrongFor } from '../../../games/inbox/fixtures.js';

/** A decision line as the real-time scheduler writes it, with only what the stage reads set. */
function line(over: Partial<DecisionLine> & Pick<DecisionLine, 'seat' | 'questionKey'>) {
  const d: DecisionLine = {
    type: 'decision',
    seq: 0,
    sentTick: 0,
    appliedTick: 0,
    latencyMs: 180,
    choice: 'legit',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'ok',
    correct: true,
    ...over,
  };
  return d;
}

function hit(tick: number, seat: Seat, cause: 'wrong' | 'landed', damage = 1): EventLine {
  return {
    type: 'event',
    tick,
    game: { kind: 'hit', seat, id: 'x', cause, damage, health: 99 },
  };
}

const card = (over: Partial<LaneCard>): LaneCard => ({
  index: 3,
  id: 'sms-1',
  label: 'spam',
  spawnTick: 60,
  landTick: 300,
  phase: 'falling',
  sinceSpawn: 30,
  age: 0,
  progress: 0.25,
  secondsToLand: 3,
  choice: null,
  ...over,
});

describe('inbox stage layout', () => {
  it('puts seat 0 left and seat 1 right, same size, inside the stage', () => {
    const [a, b] = [laneRect(0), laneRect(1)];
    expect(a.x).toBeLessThan(b.x);
    expect(a.w).toBe(b.w);
    expect(a.x + a.w).toBeLessThan(b.x);
    expect(a.x).toBeGreaterThan(0);
    expect(b.x + b.w).toBeLessThan(STAGE_W);
    // Mirrored about the centre.
    expect(a.x).toBe(STAGE_W - (b.x + b.w));
    expect(a.y + a.h).toBeLessThanOrEqual(STAGE_H);
  });

  it('fits cards inside the lane, landing just above the inbox bar', () => {
    for (const seat of [0, 1] as const) {
      const lane = laneRect(seat);
      const inbox = inboxRect(seat);
      expect(CARD_W).toBeLessThan(LANE_W);
      expect(inbox.y + inbox.h).toBeLessThanOrEqual(lane.y + lane.h);
      expect(CARD_TOP_START).toBeGreaterThan(LANE_TOP);
      expect(CARD_TOP_LAND + CARD_H).toBeLessThan(inbox.y);
      expect(CARD_TOP_LAND).toBeGreaterThan(CARD_TOP_START);
    }
  });

  it('maps fall progress to the card top linearly, clamped', () => {
    expect(cardTop(0)).toBe(CARD_TOP_START);
    expect(cardTop(1)).toBe(CARD_TOP_LAND);
    expect(cardTop(0.5)).toBe((CARD_TOP_START + CARD_TOP_LAND) / 2);
    expect(cardTop(-1)).toBe(CARD_TOP_START);
    expect(cardTop(2)).toBe(CARD_TOP_LAND);
  });

  it('gives fall progress from (tick − spawnTick) / (landTick − spawnTick)', () => {
    const item = { spawnTick: 100, landTick: 340 };
    expect(fallProgress(item, 100)).toBe(0);
    expect(fallProgress(item, 160)).toBe(0.25);
    expect(fallProgress(item, 340)).toBe(1);
    expect(fallProgress(item, 50)).toBe(0);
    expect(fallProgress(item, 999)).toBe(1);
    expect(fallProgress({ spawnTick: 5, landTick: 5 }, 0)).toBe(1);
  });
});

describe('laneResolutions', () => {
  it("keeps the seat's applied answers by message id: first frame, choice and correctness", () => {
    const lines = [
      line({ seat: 0, questionKey: 'a', appliedTick: 12, choice: 'spam', correct: true }),
      line({ seat: 1, questionKey: 'a', appliedTick: 14, choice: 'legit', correct: false }),
      line({ seat: 0, questionKey: 'b', appliedTick: 30, choice: 'smishing', correct: false }),
    ];
    // Each shows from the frame after its applied tick (the state after that step).
    expect([...laneResolutions(lines, 0)]).toEqual([
      ['a', { tick: 13, choice: 'spam', correct: true }],
      ['b', { tick: 31, choice: 'smishing', correct: false }],
    ]);
    expect([...laneResolutions(lines, 1)]).toEqual([
      ['a', { tick: 15, choice: 'legit', correct: false }],
    ]);
  });

  it('ignores lines that resolved nothing: dropped, timed out, never applied, ungraded', () => {
    const ungraded = line({ seat: 0, questionKey: 'd' });
    delete ungraded.correct;
    const lines = [
      line({ seat: 0, questionKey: 'a', status: 'dropped', error: 'landed' }),
      line({ seat: 0, questionKey: 'b', status: 'timeout', appliedTick: null, choice: null }),
      line({ seat: 0, questionKey: 'c', appliedTick: null }),
      ungraded,
      line({ seat: 0, questionKey: 'e', choice: null }),
    ];
    expect(laneResolutions(lines, 0).size).toBe(0);
  });

  it('keeps the first answer for a message (a second one is dropped by the game)', () => {
    const lines = [
      line({ seat: 0, questionKey: 'a', appliedTick: 5, choice: 'spam' }),
      line({ seat: 0, questionKey: 'a', appliedTick: 9, choice: 'legit' }),
    ];
    expect(laneResolutions(lines, 0).get('a')?.choice).toBe('spam');
  });
});

/**
 * The SMALL fixture: a spawn every 10 ticks, each falls for 30. Seat 0 answers message 0 right
 * and seat 1 answers it wrong, both on tick 5; nobody answers message 1, which lands at tick 40.
 */
function scenario(): {
  states: Map<number, InboxState>;
  lines: DecisionLine[];
} {
  const s = small();
  const states = new Map<number, InboxState>();
  const lines: DecisionLine[] = [];
  const first = itemAt(s, 0);
  for (let t = 0; t <= 120 && !s.over; t++) {
    states.set(s.tick, structuredClone(s));
    if (s.tick === 5) {
      stepInbox(s, [answer(first), answer(first, wrongFor(first))]);
      lines.push(
        line({ seat: 0, questionKey: first.id, appliedTick: 5, choice: first.label }),
        line({
          seat: 1,
          questionKey: first.id,
          appliedTick: 5,
          choice: wrongFor(first),
          correct: false,
        }),
      );
    } else {
      stepInbox(s, [null, null]);
    }
  }
  return { states, lines };
}

describe('laneCards', () => {
  const { states, lines } = scenario();
  const at = (tick: number): InboxState => {
    const s = states.get(tick);
    if (s === undefined) throw new Error(`no state at ${String(tick)}`);
    return s;
  };
  const cardsAt = (seat: Seat, tick: number) =>
    laneCards(at(tick), seat, laneResolutions(lines, seat), tick);

  it('shows a spawned, unanswered message falling, with its progress and seconds to land', () => {
    const [c] = cardsAt(0, 4);
    expect(c).toMatchObject({ index: 0, phase: 'falling', age: 0, sinceSpawn: 4 });
    expect(c?.progress).toBeCloseTo(4 / 30);
    // The view's rounding: 26 ticks → 0.4 s.
    expect(c?.secondsToLand).toBe(0.4);
  });

  it('turns an answered card cleared or wrong the frame after its applied tick, then freezes it', () => {
    const [ok] = cardsAt(0, 6).filter((c) => c.index === 0);
    expect(ok).toMatchObject({ phase: 'cleared', age: 0, choice: at(0).stream[0]?.label });
    expect(ok?.progress).toBeCloseTo(6 / 30);
    const later = cardsAt(1, 20).find((c) => c.index === 0);
    expect(later).toMatchObject({ phase: 'wrong', age: 14 });
    expect(later?.progress).toBeCloseTo(6 / 30);
    expect(later?.secondsToLand).toBe(0.4);
  });

  it('shows a verdict on the same frame as its damage', () => {
    // Applied on tick 5: on frame 5 the card still falls and the lane is at full health.
    expect(cardsAt(1, 5).find((c) => c.index === 0)?.phase).toBe('falling');
    expect(at(5).lanes[1].health).toBe(at(0).lanes[1].health);
    // Frame 6 is the state after that step: the verdict and the damage appear together.
    expect(cardsAt(1, 6).find((c) => c.index === 0)).toMatchObject({ phase: 'wrong', age: 0 });
    expect(at(6).lanes[1].health).toBeLessThan(at(5).lanes[1].health);
    // The health pulse for the hit (logged on tick 5) starts on the same frame.
    expect(lastHit([hit(5, 1, 'wrong')], 1)?.tick).toBe(6);
    expect(cardPose(cardsAt(1, 6).find((c) => c.index === 0) as LaneCard, 1).flash).toBe(1);
  });

  it('drops an answered card once its fade is over', () => {
    expect(cardsAt(0, 6 + RESOLVE_TICKS - 1).some((c) => c.index === 0)).toBe(true);
    expect(cardsAt(0, 6 + RESOLVE_TICKS).some((c) => c.index === 0)).toBe(false);
  });

  it('ignores answers from after the frame (the card still falls)', () => {
    const [c] = cardsAt(0, 3);
    expect(c).toMatchObject({ index: 0, phase: 'falling' });
  });

  it('shows a landed card at the bottom from its land tick, then drops it', () => {
    const land = itemAt(at(0), 1).landTick;
    expect(cardsAt(0, land - 1).find((c) => c.index === 1)?.phase).toBe('falling');
    const landed = cardsAt(0, land).find((c) => c.index === 1);
    expect(landed).toMatchObject({ phase: 'landed', age: 0, progress: 1, secondsToLand: 0 });
    // The match is over by then: the stage's last state, at later ticks.
    const last = at(Math.max(...states.keys()));
    const later = (tick: number) => laneCards(last, 0, laneResolutions(lines, 0), tick);
    expect(later(land + LAND_TICKS - 1).some((c) => c.index === 1)).toBe(true);
    expect(later(land + LAND_TICKS).some((c) => c.index === 1)).toBe(false);
  });

  it('orders back to front: fading, falling (soonest to land last), then holding verdicts', () => {
    // Tick 10: message 0 answered at 5 (its verdict holding, on top), message 1 falling.
    expect(cardsAt(0, 10).map((c) => [c.index, c.phase])).toEqual([
      [1, 'falling'],
      [0, 'cleared'],
    ]);
    expect(holding(cardsAt(0, 10)[1] as LaneCard)).toBe(true);
    // Tick 25: the verdict fades behind messages 2 and 1 (1 lands first, so it is in front).
    const fading = cardsAt(0, 25);
    expect(fading.map((c) => [c.index, c.phase])).toEqual([
      [0, 'cleared'],
      [2, 'falling'],
      [1, 'falling'],
    ]);
    expect(holding(fading[0] as LaneCard)).toBe(false);
    // A landed card in its hold is drawn last.
    const land = itemAt(at(0), 1).landTick;
    const atLand = cardsAt(0, land);
    expect(atLand[atLand.length - 1]).toMatchObject({ index: 1, phase: 'landed' });
  });

  it('shows the same stream in both lanes', () => {
    const ids = (seat: Seat) => cardsAt(seat, 25).map((c) => c.id);
    expect(ids(0).sort()).toEqual(ids(1).sort());
  });

  it('keeps the last landings on the final frame, and nothing once they have faded', () => {
    const s = small();
    runTo(s, 400);
    expect(s.over).toBe(true);
    const final = laneCards(s, 0, new Map(), s.tick);
    expect(final.length).toBeGreaterThan(0);
    expect(final.every((c) => c.phase === 'landed')).toBe(true);
    expect(laneCards(s, 0, new Map(), s.tick + LAND_TICKS)).toEqual([]);
  });
});

describe('cardPose', () => {
  const base = LANE_X[0] + (LANE_W - CARD_W) / 2;

  it('places a falling card by its progress; a new one drops in from above, opaque', () => {
    const settled = cardPose(card({ sinceSpawn: ENTER_TICKS }), 0);
    expect(settled).toEqual({
      x: base,
      y: cardTop(0.25),
      alpha: 1,
      flash: 0,
      textAlpha: 1,
      swiping: false,
    });
    const entering = cardPose(card({ sinceSpawn: 0 }), 0);
    expect(entering.y).toBeLessThan(settled.y);
    expect(entering.alpha).toBe(1);
    // The first message (spawned at tick 0) is in place on frame 0.
    expect(cardPose(card({ spawnTick: 0, sinceSpawn: 0 }), 0).y).toBe(cardTop(0.25));
  });

  it('flashes an answered card, holds it, then swipes it out of the lane while fading', () => {
    const c = (age: number, seat: Seat = 0) => cardPose(card({ phase: 'cleared', age }), seat);
    expect(c(0).flash).toBe(1);
    expect(c(FLASH_TICKS).flash).toBe(0);
    expect(c(RESOLVE_HOLD - 1)).toMatchObject({ x: base, alpha: 1 });
    const mid = c(RESOLVE_HOLD + 12);
    expect(mid.x).toBeLessThan(base);
    expect(mid.alpha).toBeCloseTo(0.5);
    expect(c(RESOLVE_TICKS).alpha).toBe(0);
    // Seat 1 swipes the other way (outward).
    expect(c(RESOLVE_HOLD + 12, 1).x).toBeGreaterThan(LANE_X[1] + (LANE_W - CARD_W) / 2);
  });

  it('clips a swiping card to the column and fades its words before they reach the edge', () => {
    const c = (age: number) => cardPose(card({ phase: 'wrong', age }), 0);
    expect(c(RESOLVE_HOLD - 1)).toMatchObject({ swiping: false, textAlpha: 1 });
    expect(c(RESOLVE_HOLD)).toMatchObject({ swiping: true, textAlpha: 1 });
    // The words are gone once the card has moved less than its side padding.
    const gone = RESOLVE_HOLD + Math.ceil(SWIPE_TEXT_FADE * FADE_TICKS);
    expect(c(gone).textAlpha).toBe(0);
    expect(base - c(gone).x).toBeLessThan(CARD_PAD_X);
    expect(c(gone).alpha).toBeGreaterThan(0.7);
    // Falling and landed cards are never clipped to the column.
    expect(cardPose(card({}), 0).swiping).toBe(false);
    expect(cardPose(card({ phase: 'landed', progress: 1, age: LAND_HOLD + 5 }), 0).swiping).toBe(
      false,
    );
  });

  it('shakes a wrong answer during its hold', () => {
    const shaken = [1, 2, 3, 4].map((age) => cardPose(card({ phase: 'wrong', age }), 0).x);
    expect(shaken.some((x) => x !== base)).toBe(true);
    expect(cardPose(card({ phase: 'cleared', age: 2 }), 0).x).toBe(base);
  });

  it('shakes a landed card at the bottom, then sinks it into the inbox', () => {
    const l = (age: number) => cardPose(card({ phase: 'landed', progress: 1, age }), 1);
    expect(l(0).y).toBe(CARD_TOP_LAND);
    expect([1, 2, 3].some((age) => l(age).x !== LANE_X[1] + (LANE_W - CARD_W) / 2)).toBe(true);
    expect(l(LAND_HOLD + 12).y).toBeGreaterThan(CARD_TOP_LAND);
    expect(l(LAND_HOLD + 12).alpha).toBeCloseTo(0.5);
    expect(l(LAND_TICKS).alpha).toBe(0);
  });

  it('is a pure function of the card (no randomness)', () => {
    const c = card({ phase: 'wrong', age: 3 });
    expect(cardPose(c, 0)).toEqual(cardPose({ ...c }, 0));
  });
});

describe('wrapText', () => {
  const measure = (s: string) => s.length * 10;

  it('wraps on spaces within the width', () => {
    expect(wrapText('aa bb cc dd', 50, 4, measure)).toEqual(['aa bb', 'cc dd']);
    expect(wrapText('  one   two ', 80, 4, measure)).toEqual(['one two']);
    expect(wrapText('', 80, 4, measure)).toEqual([]);
  });

  it('breaks a word wider than a line', () => {
    expect(wrapText('hxxp://example[.]com', 80, 4, measure)).toEqual([
      'hxxp://e',
      'xample[.',
      ']com',
    ]);
  });

  it('clamps to maxLines and ends the last line with an ellipsis that fits', () => {
    const lines = wrapText('one two three four five six seven', 90, 2, measure);
    expect(lines).toEqual(['one two', 'three…']);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(90);
    const tight = wrapText('aaaa bbbb cccc', 40, 2, measure);
    expect(tight).toEqual(['aaaa', 'bbb…']);
  });
});

describe('health pulses', () => {
  it("finds the seat's latest hit; it shows on the frame after its event tick", () => {
    const events = [hit(10, 0, 'wrong'), hit(20, 1, 'landed', 3), hit(30, 0, 'landed', 3)];
    expect(lastHit(events, 0)).toEqual({ tick: 31, cause: 'landed', damage: 3 });
    expect(lastHit(events, 1)).toEqual({ tick: 21, cause: 'landed', damage: 3 });
    expect(lastHit([], 0)).toBeNull();
    const gameOver: EventLine = {
      type: 'event',
      tick: 40,
      game: { kind: 'game_over', winner: 0, health: [1, 0] },
    };
    expect(lastHit([...events, gameOver], 0)?.tick).toBe(31);
  });

  it('pulses from 1 down to 0 over PULSE_TICKS', () => {
    const h = { tick: 100, cause: 'wrong' as const, damage: 1 };
    expect(pulseAt(h, 100)).toBe(1);
    expect(pulseAt(h, 100 + PULSE_TICKS / 2)).toBeCloseTo(0.5);
    expect(pulseAt(h, 100 + PULSE_TICKS)).toBe(0);
    expect(pulseAt(h, 99)).toBe(0);
    expect(pulseAt(null, 100)).toBe(0);
  });
});

describe('labels, clock and banner', () => {
  it('labels the options and seats in plain words', () => {
    expect(optionLabel('legit')).toBe('Legit');
    expect(optionLabel('spam')).toBe('Spam');
    expect(optionLabel('smishing')).toBe('Smishing');
    expect(optionLabel('other')).toBe('other');
    expect(seatLabel(0, 'Jev (TypeSafe)')).toBe('P1 · Jev (TypeSafe)');
    expect(seatLabel(1, '')).toBe('P2');
  });

  it('formats ticks as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59)).toBe('0:00');
    expect(formatClock(60)).toBe('0:01');
    expect(formatClock(3600)).toBe('1:00');
    expect(formatClock(125 * 60 + 30)).toBe('2:05');
  });

  it('gives accuracy as a whole percentage, or null before any answer', () => {
    expect(accuracyPct({ answered: 0, correct: 0 })).toBeNull();
    expect(accuracyPct({ answered: 3, correct: 2 })).toBe(67);
  });

  it('shows the banner only once the game is over, naming the winner', () => {
    const s = small();
    expect(bannerText(s, ['A', 'B'])).toBeNull();
    // Seat 1 answers everything wrong, seat 0 everything right.
    const head = (seat: Seat) => s.stream.find((i) => i.id === s.lanes[seat].active[0]);
    while (!s.over) {
      const [right, wrong] = [head(0), head(1)];
      stepInbox(s, [
        right === undefined ? null : answer(right),
        wrong === undefined ? null : answer(wrong, wrongFor(wrong)),
      ]);
    }
    const b = bannerText(s, ['Jev (TypeSafe)', 'Random (uniform)']);
    expect(b?.title).toBe('P1 · Jev (TypeSafe) wins');
    expect(b?.sub).toContain(`Inbox health ${String(s.lanes[0].health)} – `);
    expect(b?.sub).toContain('accuracy 100% – 0%');
  });

  it('calls a level game a draw', () => {
    const s = small();
    runTo(s, 400);
    expect(s.lanes[0].health).toBe(s.lanes[1].health);
    expect(bannerText(s, ['A', 'B'])?.title).toBe('Draw');
    expect(bannerText(s, ['A', 'B'])?.sub).toContain('accuracy — – —');
  });
});

describe('card rows: whole or not at all', () => {
  const open = { top: 0, bottom: 2000 };
  const rows = [HEADER_ROW, ...[0, 1, 2, 3].map((i) => textRow(i))];

  it('lays out the header row, then four text lines, inside the card', () => {
    expect(HEADER_ROW.top).toBeGreaterThan(0);
    for (const [i, r] of rows.entries()) {
      expect(r.bottom).toBeGreaterThan(r.top);
      if (i > 0) expect(r.top).toBeGreaterThanOrEqual(rows[i - 1]?.bottom ?? 0);
    }
    expect(textRow(3).bottom).toBeLessThanOrEqual(CARD_H);
  });

  it('sets the message larger, on fewer lines, at a raised legibility floor', () => {
    // A desktop player: the design, four lines of 46 px.
    expect(messageLayout(0)).toEqual({ px: MESSAGE_PX, lineH: CARD_LINE_H, lines: CARD_LINES });
    expect(messageLayout(26)).toEqual(messageLayout(0));
    // The square video (floor ~49 logical px, 0.5625 output px each): about 34 px, three lines.
    const sq = messageLayout(49.2);
    expect(sq.lines).toBe(3);
    expect(sq.px * 0.5625).toBeGreaterThanOrEqual(34);
    expect(sq.lineH).toBeGreaterThanOrEqual(sq.px);
    // The same text area: the last line still ends inside the card.
    expect(textRow(sq.lines - 1, sq.lineH).bottom).toBeLessThanOrEqual(
      textRow(CARD_LINES - 1).bottom,
    );
    expect(messageLayout(200).px).toBe(MESSAGE_MAX_PX);
  });

  it('draws every row of a card nothing covers', () => {
    expect(rows.every((r) => rowVisible([100], 0, r, open))).toBe(true);
  });

  it('hides the header of a card in a pile, whose strip is thinner than its header row', () => {
    // A pile: each card 38 px below the one behind it (drawn after it, so in front).
    const tops = [100, 138, 176, 214];
    for (let i = 0; i < 3; i++) {
      for (const r of rows) expect(rowVisible(tops, i, r, open)).toBe(false);
    }
    // The front card is whole.
    expect(rows.every((r) => rowVisible(tops, 3, r, open))).toBe(true);
  });

  it('keeps a header that fits whole above the card in front, and drops the cut lines', () => {
    const strip = HEADER_ROW.bottom + COVER_ABOVE + 1;
    const tops = [100, 100 + strip];
    expect(rowVisible(tops, 0, HEADER_ROW, open)).toBe(true);
    expect(rowVisible(tops, 0, textRow(0), open)).toBe(false);
  });

  it('hides rows a card in front covers from above, down to its shadow', () => {
    // The card in front sits above: rows of the back card below its bottom (and shadow) show.
    const front = 100;
    const back = front + 150;
    const tops = [back, front];
    const clear = (r: { top: number }) => back + r.top >= front + CARD_H + COVER_BELOW;
    for (const r of rows) expect(rowVisible(tops, 0, r, open)).toBe(clear(r));
    expect(rows.some(clear)).toBe(true);
  });

  it('hides rows under the game-over banner, whole', () => {
    const y = BANNER_BAND.bottom - textRow(1).top - 10; // line 1 straddles the banner's bottom edge
    expect(rowVisible([y], 0, textRow(1), open, [BANNER_BAND])).toBe(false);
    expect(rowVisible([y], 0, textRow(2), open, [BANNER_BAND])).toBe(true);
    expect(rowVisible([y], 0, textRow(1), open)).toBe(true);
  });

  it('ignores cards not drawn (null) and hides rows outside the open band', () => {
    expect(rowVisible([100, null], 0, HEADER_ROW, open)).toBe(true);
    expect(rowVisible([100], 0, HEADER_ROW, { top: 130, bottom: 2000 })).toBe(false);
    expect(rowVisible([100], 0, textRow(3), { top: 0, bottom: 300 })).toBe(false);
    expect(rowVisible([null], 0, HEADER_ROW, open)).toBe(false);
  });
});

describe('header and inbox bar text', () => {
  it('offers the full label, then the label without its model version', () => {
    expect(headerLabels(1, 'OpenAI Decisions (gpt-6-luna)')).toEqual([
      'P2 · OpenAI Decisions (gpt-6-luna)',
      'P2 · OpenAI Decisions',
      'P2 · OpenAI',
    ]);
    expect(headerLabels(0, 'Jev (TypeSafe)')).toEqual(['P1 · Jev (TypeSafe)', 'P1 · Jev']);
    expect(headerLabels(0, 'Always legit')).toEqual(['P1 · Always legit']);
    expect(headerLabels(0, '')).toEqual(['P1']);
  });

  it('reserves space for the starting health, so the label never moves with the number', () => {
    expect(healthDigits(100)).toBe(3);
    expect(healthDigits(9)).toBe(1);
  });

  it('shortens the accuracy text before it would run into the label', () => {
    expect(accuracyTexts(92)).toEqual(['92% right', '92%']);
  });
});
