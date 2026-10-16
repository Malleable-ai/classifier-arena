import { describe, expect, it } from 'vitest';
import type { Seat } from '../../../src/core/classifier/types.js';
import type { DecisionLine, HeaderLine } from '../../../src/core/log/schema.js';
import { createCluesTimeline, type TurnSlot } from '../../../src/web/games/clues/timeline.js';
import { cluesRenderer } from '../../../src/web/games/clues/renderer.js';
import type { InFlight } from '../../../src/web/games/index.js';
import { frameBase, inFlightAt } from '../../../src/web/shell/frames.js';
import {
  badgeOf,
  FLASH_TICKS,
  noteText,
  noteTexts,
  panelHeaderOf,
  panelModel,
  panelStatus,
  THINKING_AFTER_TICKS,
  topProbabilityCount,
  type PanelHeader,
  type PanelOptions,
  type Verdict,
} from '../../../src/web/shell/panel.js';
import { framePanel } from '../../../src/web/shell/stage.js';
import { MODEL_COLORS, NEUTRAL_COLORS } from '../../../src/web/shell/theme.js';
import { syntheticCluesLog } from '../games/clues/synthetic.js';

const HEADER: PanelHeader = {
  labels: ['Jev (TypeSafe)', 'OpenAI Decisions (gpt-6-luna)'],
  cadence: { kind: 'realtime', tickRate: 60 },
  warmupCostUsd: [0.001, 0.002],
};
const TURNS: PanelHeader = { ...HEADER, cadence: { kind: 'turns' } };
/** A game whose options are colors: labels come from the renderer, never from the panel. */
const OPTS: PanelOptions = { optionLabel: (id) => id.toUpperCase().replace('_', ' ') };

let seq = 0;
function line(over: Partial<DecisionLine>): DecisionLine {
  return {
    type: 'decision',
    seat: 0,
    seq: seq++,
    questionKey: 'q',
    sentTick: 0,
    appliedTick: 10,
    latencyMs: 150,
    choice: 'red',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'ok',
    ...over,
  };
}

/** Probabilities over `n` options o0 … o{n-1}, o{i} at (i + 1) / sum. */
function probs(n: number): Record<string, number> {
  const sum = (n * (n + 1)) / 2;
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${String(i)}`, (i + 1) / sum]));
}

describe('topProbabilityCount', () => {
  it('shows every option up to 6, else the top 5', () => {
    expect(topProbabilityCount(2)).toBe(2);
    expect(topProbabilityCount(3)).toBe(3);
    expect(topProbabilityCount(6)).toBe(6);
    expect(topProbabilityCount(7)).toBe(5);
    expect(topProbabilityCount(11)).toBe(5);
    expect(topProbabilityCount(16)).toBe(5);
  });
});

describe('panelModel', () => {
  it('shows a neutral panel per seat with no decisions', () => {
    const m = panelModel([], 0, HEADER, OPTS);
    expect(m.panels[0].label).toBe('P1 · Jev (TypeSafe)');
    expect(m.panels[1].label).toBe('P2 · OpenAI Decisions (gpt-6-luna)');
    expect(m.panels[0].choice).toBeNull();
    expect(m.panels[0].choiceLabel).toBeNull();
    expect(m.panels[0].status).toBeNull();
    expect(m.panels[0].latencyMs).toBeNull();
    expect(m.panels[0].perSecond).toBe(0);
    expect(m.panels[0].bars).toBeNull();
    expect(m.panels[0].costUsd).toBeCloseTo(0.001);
    expect(m.ticker).toEqual([]);
  });

  it('picks the latest decision per seat at the tick and never shows the future', () => {
    const lines = [
      line({ seat: 0, appliedTick: 10, choice: 'red', latencyMs: 120 }),
      line({ seat: 1, appliedTick: 12, choice: 'blue', latencyMs: 180 }),
      line({ seat: 0, appliedTick: 30, choice: 'dark_green', latencyMs: 200 }),
      line({ seat: 1, appliedTick: 500, choice: 'red', latencyMs: 90 }),
    ];
    const m = panelModel(lines, 30, HEADER, OPTS);
    expect(m.panels[0].choice).toBe('dark_green');
    expect(m.panels[0].choiceLabel).toBe('DARK GREEN');
    expect(m.panels[0].latencyMs).toBe(200);
    expect(m.panels[1].choice).toBe('blue');
    expect(m.ticker.map((t) => t.choice)).toEqual(['dark_green', 'blue', 'red']);
    expect(panelModel(lines, 29, HEADER, OPTS).panels[0].choice).toBe('red');
    expect(panelModel(lines, 9, HEADER, OPTS).panels[0].choice).toBeNull();
  });

  it('places a never-applied decision at its arrival tick (sent + latency, rounded up)', () => {
    const late = line({ appliedTick: null, sentTick: 100, latencyMs: 210, status: 'timeout' });
    expect(panelModel([late], 112, HEADER, OPTS).panels[0].status).toBeNull();
    expect(panelModel([late], 113, HEADER, OPTS).panels[0].status).toBe('timeout');
  });

  it('counts decisions per second over the last 5 s of game time', () => {
    // 10 decisions for P1 between ticks 100 and 1000, 100 ticks apart.
    const lines = Array.from({ length: 10 }, (_, i) => line({ appliedTick: 100 + i * 100 }));
    // At tick 1000 the window is (700, 1000]: ticks 800, 900, 1000 -> 3 in 5 s.
    expect(panelModel(lines, 1000, HEADER, OPTS).panels[0].perSecond).toBeCloseTo(3 / 5);
    // Before 5 s have passed, divide by the elapsed time instead.
    expect(panelModel(lines, 120, HEADER, OPTS).panels[0].perSecond).toBeCloseTo(1 / 2);
    expect(panelModel(lines, 0, HEADER, OPTS).panels[0].perSecond).toBe(0);
  });

  it('sorts the probabilities of the latest decision, highest first, with option labels', () => {
    const m = panelModel(
      [line({ probabilities: { red: 0.1, blue: 0.6, dark_green: 0.3 } })],
      10,
      HEADER,
      OPTS,
    );
    expect(m.panels[0].bars).toEqual([
      { id: 'blue', label: 'BLUE', p: 0.6 },
      { id: 'dark_green', label: 'DARK GREEN', p: 0.3 },
      { id: 'red', label: 'RED', p: 0.1 },
    ]);
  });

  it('shows every option up to 6 and the top 5 of more, unless the renderer sets a count', () => {
    const bars = (n: number, opts: PanelOptions = OPTS) =>
      panelModel([line({ choice: 'o0', probabilities: probs(n) })], 10, HEADER, opts).panels[0]
        .bars;
    expect(bars(3)?.map((b) => b.id)).toEqual(['o2', 'o1', 'o0']);
    expect(bars(6)).toHaveLength(6);
    expect(bars(11)?.map((b) => b.id)).toEqual(['o10', 'o9', 'o8', 'o7', 'o6']);
    expect(bars(16)).toHaveLength(5);
    expect(bars(11, { ...OPTS, bars: 3 })?.map((b) => b.id)).toEqual(['o10', 'o9', 'o8']);
  });

  it('keeps option order for equal probabilities', () => {
    const m = panelModel(
      [line({ probabilities: { c: 0.25, a: 0.25, d: 0.25, b: 0.25 } })],
      10,
      HEADER,
      OPTS,
    );
    expect(m.panels[0].bars?.map((b) => b.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('sums cost (warm-up plus resolved decisions) per seat', () => {
    const lines = [
      line({ seat: 0, costUsd: 0.0001, appliedTick: 5 }),
      line({ seat: 0, costUsd: 0.0002, appliedTick: 6 }),
      line({ seat: 1, costUsd: 0.0005, appliedTick: 6 }),
      line({ seat: 0, costUsd: 0.9, appliedTick: 100 }),
    ];
    const m = panelModel(lines, 50, HEADER, OPTS);
    expect(m.panels[0].costUsd).toBeCloseTo(0.0013);
    expect(m.panels[1].costUsd).toBeCloseTo(0.0025);
  });

  it('labels dropped, timeout, error and refusal decisions', () => {
    const lines = [
      line({ seat: 0, appliedTick: 5, status: 'dropped', error: 'dropped: busy' }),
      line({
        seat: 1,
        appliedTick: null,
        sentTick: 0,
        latencyMs: 1000,
        choice: null,
        status: 'timeout',
      }),
      line({
        seat: 0,
        appliedTick: null,
        sentTick: 70,
        latencyMs: 100,
        choice: null,
        status: 'error',
        error: 'invalid answer: refusal',
      }),
      line({
        seat: 1,
        appliedTick: null,
        sentTick: 80,
        latencyMs: 100,
        choice: null,
        status: 'error',
        error: 'HTTP 500',
      }),
    ];
    expect(panelModel(lines, 5, HEADER, OPTS).panels[0].status).toBe('dropped');
    expect(panelModel(lines, 60, HEADER, OPTS).panels[1].status).toBe('timeout');
    const m = panelModel(lines, 200, HEADER, OPTS);
    expect(m.panels[0].status).toBe('refusal');
    expect(m.panels[0].choiceLabel).toBeNull();
    expect(m.panels[1].status).toBe('error');
    expect(m.ticker.map((t) => t.status)).toEqual(['error', 'refusal', 'timeout', 'dropped']);
    expect(m.ticker[3]?.text).toBe('P1 Jev → RED 150 ms');
    expect(m.ticker[2]?.text).toBe('P2 OpenAI → timeout 1000 ms');
    // A refusal logged with the `refusal` status (since 2026-10-12) reads the same.
    const now = line({
      seat: 0,
      appliedTick: null,
      choice: null,
      status: 'refusal',
      error: 'invalid answer: refusal',
    });
    expect(panelStatus(now)).toBe('refusal');
  });

  it('keeps only the last 6 ticker entries, newest first, and flashes a fresh decision', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      line({ seat: (i % 2) as 0 | 1, appliedTick: i * 10, choice: 'dark_green' }),
    );
    const m = panelModel(lines, 90, HEADER, OPTS);
    expect(m.ticker).toHaveLength(6);
    expect(m.ticker[0]?.at).toBe(90);
    expect(m.ticker[0]?.text).toBe('P2 OpenAI → DARK GREEN 150 ms');
    expect(m.panels[1].flash).toBeCloseTo(1);
    expect(panelModel(lines, 90 + FLASH_TICKS, HEADER, OPTS).panels[1].flash).toBe(0);
    expect(m.panels[0].flash).toBeLessThan(1);
  });

  it("reads the frame's decisions in the order frameBase resolved them", () => {
    // Log order is not resolution order: a timeout (arrives at tick 77) is logged before an
    // answer applied at tick 20, as the real-time scheduler writes them.
    const lines = [
      line({ seat: 1, appliedTick: null, sentTick: 17, latencyMs: 1000, status: 'timeout' }),
      line({ seat: 0, appliedTick: 20, choice: 'blue' }),
      line({ seat: 0, appliedTick: 90, choice: 'dark_green' }),
    ];
    const frame = frameBase({
      frame: 80,
      tick: 80,
      state: null,
      labels: HEADER.labels,
      players: ['jev', 'openai'],
      cadence: HEADER.cadence,
      decisions: lines,
      events: [],
    });
    const m = panelModel(frame.decisions, 80, HEADER, OPTS);
    expect(m.ticker.map((t) => t.at)).toEqual([77, 20]);
    expect(m.panels[0].choice).toBe('blue');
    expect(m.panels[1].status).toBe('timeout');
  });

  it('works by turns for turn games: a turn resolves once played, and there is no rate', () => {
    const lines = [
      line({ seat: 0, sentTick: 0, appliedTick: 0, choice: 'red' }),
      line({ seat: 1, sentTick: 0, appliedTick: 0, choice: 'blue' }),
      line({ seat: 0, sentTick: 1, appliedTick: 1, choice: 'dark_green' }),
    ];
    expect(panelModel(lines, 0, TURNS, OPTS).panels[0].choice).toBeNull();
    const m = panelModel(lines, 1, TURNS, OPTS);
    expect(m.panels[0].choice).toBe('red');
    expect(m.panels[1].choice).toBe('blue');
    expect(m.panels[0].perSecond).toBeNull();
    expect(m.panels[0].flash).toBe(1);
    expect(panelModel(lines, 2, TURNS, OPTS).panels[0].choice).toBe('dark_green');
    expect(panelModel(lines, 2, TURNS, OPTS).panels[1].flash).toBe(0);
  });
});

describe('panelModel: what the badge says', () => {
  it('shows no status for an ok answer, only for timeout, error, refusal and dropped', () => {
    const ok = panelModel([line({})], 10, HEADER, OPTS).panels[0];
    expect(ok.status).toBe('ok');
    expect(ok.verdict).toBeNull();
    const dropped = panelModel(
      [line({ status: 'dropped', error: 'dropped: landed' })],
      10,
      HEADER,
      OPTS,
    );
    expect(dropped.panels[0].status).toBe('dropped');
  });

  it('graded answers get a verdict: right or wrong', () => {
    const lines = [
      line({ seat: 0, appliedTick: 10, correct: true }),
      line({ seat: 1, appliedTick: 10, correct: false }),
    ];
    const m = panelModel(lines, 10, HEADER, OPTS);
    expect(m.panels[0].verdict).toBe('right');
    expect(m.panels[1].verdict).toBe('wrong');
    expect(m.ticker.map((t) => t.verdict)).toEqual(['wrong', 'right']);
    // A non-ok line has no verdict, whatever it carries.
    const t = line({
      appliedTick: null,
      sentTick: 0,
      latencyMs: 100,
      status: 'timeout',
      correct: false,
    });
    expect(panelModel([t], 20, HEADER, OPTS).panels[0].verdict).toBeNull();
  });

  it('turn games: a verdict waits until its turn is played, so the panel never spoils a reveal', () => {
    // Turn 3's answer has landed (the timeline put it in the frame early) but turn 3 isn't played.
    const landed = line({ sentTick: 3, appliedTick: 3, correct: false, choice: 'red' });
    const early = panelModel([landed], 4, TURNS, OPTS, { playedTick: 3 });
    expect(early.panels[0].choice).toBe('red');
    expect(early.panels[0].verdict).toBeNull();
    expect(early.ticker[0]?.verdict).toBeNull();
    const played = panelModel([landed], 4, TURNS, OPTS, { playedTick: 4 });
    expect(played.panels[0].verdict).toBe('wrong');
  });
});

describe('panelModel: a headline filter (the fighter: moves it performed)', () => {
  const APPLIED: PanelOptions = { ...OPTS, headline: (d) => d.status === 'ok' };
  // In resolution order, as frameBase hands them over.
  const lines = [
    line({ seat: 0, appliedTick: 10, choice: 'heavy_punch', latencyMs: 180 }),
    line({ seat: 1, appliedTick: 15, choice: 'jab' }),
    line({ seat: 0, appliedTick: 20, choice: 'throw', status: 'dropped', latencyMs: 196 }),
  ];

  it('keeps the last applied move as the headline; a newer dropped answer is the note', () => {
    const m = panelModel(lines, 30, HEADER, APPLIED);
    expect(m.panels[0].choiceLabel).toBe('HEAVY PUNCH');
    expect(m.panels[0].status).toBe('ok');
    expect(m.panels[0].latencyMs).toBe(180);
    expect(m.panels[0].note).toEqual({
      choiceLabel: 'THROW',
      status: 'dropped',
      statusText: 'dropped',
    });
    expect(noteText({ choiceLabel: 'THROW', status: 'dropped', statusText: 'dropped' })).toBe(
      'skipped (dropped): THROW',
    );
    // A seat whose latest answer was applied has no note.
    expect(m.panels[1].note).toBeNull();
    // The dropped answer is still in the ticker, newest first.
    expect(m.ticker[0]?.status).toBe('dropped');
  });

  it('names a dropped answer in the game’s plain words (droppedLabel)', () => {
    const droppedLabel = (d: DecisionLine): string =>
      d.error === 'dropped: notFighting' ? 'round over' : 'busy';
    const why: PanelOptions = { ...APPLIED, droppedLabel };
    const busy = [...lines.slice(0, 2), { ...lines[2], error: 'dropped: busy' } as DecisionLine];
    const m = panelModel(busy, 30, HEADER, why);
    expect(m.panels[0].note).toMatchObject({ status: 'dropped', statusText: 'busy' });
    expect(
      noteTexts(m.panels[0].note ?? { choiceLabel: null, status: 'ok', statusText: '' }),
    ).toEqual(['skipped (busy): THROW', 'busy: THROW']);
    expect(m.ticker[0]).toMatchObject({ status: 'dropped', statusText: 'busy' });
    // Without the filter it is the headline, its badge in the same words.
    const head = panelModel(busy, 30, HEADER, { ...OPTS, droppedLabel });
    expect(head.panels[0]).toMatchObject({ status: 'dropped', statusText: 'busy' });
    expect(badgeOf('dropped', null, 'busy')).toEqual({
      kind: 'status',
      status: 'dropped',
      text: 'busy',
    });
    // No hook: "dropped"; other statuses keep their names.
    const plain = panelModel([line({ status: 'timeout', choice: null })], 30, HEADER, OPTS);
    expect(plain.panels[0].statusText).toBe('timeout');
  });

  it('flashes when a move is applied, not when an answer is dropped', () => {
    expect(panelModel(lines, 10, HEADER, APPLIED).panels[0].flash).toBe(1);
    // The dropped answer at tick 20 doesn't relight it: it keeps fading from tick 10.
    expect(panelModel(lines, 20, HEADER, APPLIED).panels[0].flash).toBeCloseTo(
      1 - 10 / FLASH_TICKS,
    );
    // Without the filter the dropped answer is the headline, as before.
    const plain = panelModel(lines, 20, HEADER, OPTS).panels[0];
    expect(plain.status).toBe('dropped');
    expect(plain.flash).toBe(1);
    expect(plain.note).toBeNull();
  });

  it('a newer applied move replaces the note', () => {
    const more = [...lines, line({ seat: 0, appliedTick: 40, choice: 'sweep' })];
    const p = panelModel(more, 40, HEADER, APPLIED).panels[0];
    expect(p.choiceLabel).toBe('SWEEP');
    expect(p.note).toBeNull();
  });

  it('before any applied move: waiting, with the dropped answer as the note', () => {
    const only = [line({ seat: 0, appliedTick: 5, choice: 'jab', status: 'dropped' })];
    const p = panelModel(only, 10, HEADER, APPLIED).panels[0];
    expect(p.status).toBeNull();
    expect(p.choiceLabel).toBeNull();
    expect(p.note?.status).toBe('dropped');
  });
});

describe('panelModel: a request the match end cancelled is not an answer', () => {
  // In resolution order, as frameBase hands them over.
  const lines = [
    line({ seat: 1, appliedTick: 4470, choice: 'red', latencyMs: 190 }),
    line({ seat: 0, appliedTick: 4480, choice: 'blue', latencyMs: 165, costUsd: 0.001 }),
    line({
      seat: 1,
      sentTick: 4485,
      appliedTick: null,
      latencyMs: 238.7,
      choice: null,
      status: 'dropped',
      error: 'matchOver',
      costUsd: 0.003,
    }),
    line({
      seat: 0,
      sentTick: 4499,
      appliedTick: null,
      latencyMs: 2,
      choice: null,
      status: 'dropped',
      error: 'matchOver',
      costUsd: 0.002,
    }),
  ];
  const m = panelModel(lines, 4500, HEADER, OPTS);

  it("keeps each seat's last real answer on the final frame", () => {
    expect(m.panels[0]).toMatchObject({ choice: 'blue', status: 'ok', latencyMs: 165 });
    expect(m.panels[1]).toMatchObject({ choice: 'red', status: 'ok', latencyMs: 190 });
  });

  it('leaves it out of the ticker and the rate, but not the cost', () => {
    expect(m.ticker.map((t) => t.text)).toEqual(['P1 Jev → BLUE 165 ms', 'P2 OpenAI → RED 190 ms']);
    expect(m.panels[0].costUsd).toBeCloseTo(0.001 + 0.001 + 0.002);
    expect(m.panels[1].costUsd).toBeCloseTo(0.002 + 0.003);
    expect(m.panels[0].perSecond).toBeCloseTo(1 / 5);
  });
});

describe('inFlightAt: the request each seat has out', () => {
  it('real-time: from the tick after it was sent until it resolves; never its answer', () => {
    const d = line({ seat: 1, seq: 7, questionKey: 'sms-1', sentTick: 100, appliedTick: 112 });
    const rt = HEADER.cadence;
    expect(inFlightAt([d], 100, rt)).toEqual([null, null]);
    expect(inFlightAt([d], 101, rt)).toEqual([
      null,
      { seq: 7, questionKey: 'sms-1', sentTick: 100 },
    ]);
    expect(inFlightAt([d], 111, rt)[1]).not.toBeNull();
    expect(inFlightAt([d], 112, rt)).toEqual([null, null]);
    expect(Object.keys(inFlightAt([d], 105, rt)[1] ?? {}).sort()).toEqual([
      'questionKey',
      'sentTick',
      'seq',
    ]);
  });

  it('turns: the turn being played (sent this turn), until it is played', () => {
    const d = line({ seat: 0, seq: 2, questionKey: 't2', sentTick: 2, appliedTick: 2 });
    expect(inFlightAt([d], 1, TURNS.cadence)[0]).toBeNull();
    expect(inFlightAt([d], 2, TURNS.cadence)[0]).toEqual({
      seq: 2,
      questionKey: 't2',
      sentTick: 2,
    });
    expect(inFlightAt([d], 3, TURNS.cadence)[0]).toBeNull();
  });

  it('frameBase sets it on every frame', () => {
    const d = line({ seat: 0, seq: 3, sentTick: 10, appliedTick: 20 });
    const f = frameBase({
      frame: 15,
      tick: 15,
      state: null,
      labels: HEADER.labels,
      players: ['jev', 'openai'],
      cadence: HEADER.cadence,
      decisions: [d],
      events: [],
    });
    expect(f.inFlight).toEqual([{ seq: 3, questionKey: 'q', sentTick: 10 }, null]);
    // And each seat's player color.
    expect(f.colors).toEqual([MODEL_COLORS['jev'], MODEL_COLORS['openai']]);
  });
});

describe('panelModel: thinking', () => {
  const out = (seq: number, questionKey: string, sentTick: number): InFlight => ({
    seq,
    questionKey,
    sentTick,
  });

  it('turn games: a seat asked this turn shows "thinking" and its last answer as the previous one', () => {
    const t0 = line({
      seat: 0,
      seq: 0,
      questionKey: 't0',
      sentTick: 0,
      appliedTick: 0,
      choice: 'red',
      correct: true,
    });
    const m = panelModel([t0], 1, TURNS, OPTS, {
      playedTick: 1,
      inFlight: [out(1, 't1', 1), null],
    });
    expect(m.panels[0]).toMatchObject({
      thinking: true,
      choice: null,
      choiceLabel: null,
      status: null,
      verdict: null,
      latencyMs: null,
      bars: null,
      previous: { choiceLabel: 'RED', status: 'ok', verdict: 'right' },
    });
    // The other seat has nothing out: it keeps its (empty) panel.
    expect(m.panels[1].thinking).toBe(false);
    // The ticker is history: it keeps the previous answer.
    expect(m.ticker).toHaveLength(1);
  });

  it('turn games: once the answer has landed in the frame, it is the answer, not thinking', () => {
    const t1 = line({
      seat: 0,
      seq: 1,
      questionKey: 't1',
      sentTick: 1,
      appliedTick: 1,
      choice: 'blue',
    });
    const m = panelModel([t1], 2, TURNS, OPTS, {
      playedTick: 1,
      inFlight: [out(1, 't1', 1), null],
    });
    expect(m.panels[0]).toMatchObject({ thinking: false, choice: 'blue', previous: null });
  });

  it('turn games: thinking before any answer has no previous', () => {
    const m = panelModel([], 0, TURNS, OPTS, { playedTick: 0, inFlight: [out(0, 't0', 0), null] });
    expect(m.panels[0]).toMatchObject({ thinking: true, previous: null });
  });

  it('real-time: the last answer stays up for a while; a slow request on a new key then shows thinking', () => {
    const a = line({ seat: 1, seq: 4, questionKey: 'sms-1', appliedTick: 100, choice: 'red' });
    const next = out(5, 'sms-2', 100);
    const at = (tick: number) =>
      panelModel([a], tick, HEADER, OPTS, { inFlight: [null, next] }).panels[1];
    expect(at(100 + THINKING_AFTER_TICKS - 1)).toMatchObject({ thinking: false, choice: 'red' });
    expect(at(100 + THINKING_AFTER_TICKS)).toMatchObject({
      thinking: true,
      choice: null,
      previous: { choiceLabel: 'RED', status: 'ok', verdict: null },
    });
  });

  it('real-time: one question key all match (the fighter) never shows thinking', () => {
    const a = line({ seat: 0, seq: 0, questionKey: 'next_move', appliedTick: 100 });
    const m = panelModel([a], 500, HEADER, OPTS, { inFlight: [out(1, 'next_move', 400), null] });
    expect(m.panels[0].thinking).toBe(false);
  });

  it('nothing in flight (live mode, or between questions): the last answer as before', () => {
    const a = line({ seat: 0, questionKey: 'sms-1', appliedTick: 100 });
    expect(panelModel([a], 900, HEADER, OPTS).panels[0].thinking).toBe(false);
    expect(panelModel([a], 900, HEADER, OPTS, { inFlight: [null, null] }).panels[0].thinking).toBe(
      false,
    );
  });
});

describe('the panel over a Clue Clash replay (synthetic log)', async () => {
  const log = await syntheticCluesLog();
  const tl = createCluesTimeline(log);
  const header = panelHeaderOf(log.header);
  const panelAt = (frame: number) => framePanel(tl.at(frame), header, cluesRenderer);
  const slots = tl.schedule.slots;
  const slotOf = (turn: number): TurnSlot => {
    const s = slots[turn];
    if (s === undefined) throw new Error(`no turn ${String(turn)}`);
    return s;
  };
  const lineOf = (turn: number, seat: Seat): DecisionLine => {
    const d = log.decisions.find((l) => l.seat === seat && l.sentTick === turn);
    if (d === undefined) throw new Error(`no line for turn ${String(turn)} seat ${String(seat)}`);
    return d;
  };
  const verdictOf = (d: DecisionLine): Verdict | null =>
    d.status === 'ok' && typeof d.correct === 'boolean' ? (d.correct ? 'right' : 'wrong') : null;
  /** What the stage says about a seat's step on screen: its ✓/✗ mark once scored, else null. */
  const stageVerdict = (frame: number, seat: Seat): Verdict | null => {
    const { scene } = tl.at(frame);
    const mark = scene.seats[seat].marks[scene.step - 1] ?? null;
    return mark === 'right' || mark === 'wrong' ? mark : null;
  };

  it('on every frame, panel and stage agree: thinking until the answer lands, a verdict once the step is marked', () => {
    for (const slot of slots) {
      for (let f = slot.start; f < slot.end; f++) {
        const { scene } = tl.at(f);
        const panel = panelAt(f);
        for (const seat of [0, 1] as const) {
          const at = `turn ${String(slot.turn)}, frame ${String(f)}, seat ${String(seat)}`;
          const p = panel.panels[seat];
          const d = lineOf(slot.turn, seat);
          // The request for this step is out from its prompt until its answer is on the board.
          expect(p.thinking, at).toBe(f < slot.arrive[seat]);
          expect(p.thinking, at).toBe(!scene.seats[seat].arrived);
          if (p.thinking) {
            expect(p.choice, at).toBeNull();
            expect(p.verdict, at).toBeNull();
            continue;
          }
          expect(p.choice, at).toBe(d.choice);
          expect(p.previous, at).toBeNull();
          // The verdict appears with the stage's ✓/✗ for the step (its score phase), never before.
          expect(p.verdict, at).toBe(f >= slot.scoreStart ? verdictOf(d) : null);
          expect(p.verdict, at).toBe(stageVerdict(f, seat));
        }
      }
    }
  });

  it('steps 1 and 2: no reveal; thinking at the prompt, the answer as it lands, its verdict when scored', () => {
    for (const turn of [3, 4]) {
      const slot = slotOf(turn);
      expect(slot.step).toBe(turn - 2);
      expect(slot.revealStart).toBeNull();
      // The step's clue is up: both seats are asked; their last answers (the step before) are the
      // previous ones, with the verdict the stage gave them.
      const prompt = panelAt(slot.start);
      for (const seat of [0, 1] as const) {
        const before = lineOf(turn - 1, seat);
        expect(prompt.panels[seat]).toMatchObject({
          thinking: true,
          choice: null,
          verdict: null,
          previous: { choiceLabel: before.choice, verdict: verdictOf(before) },
        });
      }
      if (slot.step === 2) {
        // The board still shows step 1's marks; the panel's previous verdicts are the same.
        const { scene } = tl.at(slot.start);
        for (const seat of [0, 1] as const) {
          expect(prompt.panels[seat].previous?.verdict).toBe(scene.seats[seat].marks[0]);
        }
      }
      // The faster seat's answer lands first: it shows, without a verdict; the other still thinks.
      const first = slot.arrive[0] < slot.arrive[1] ? 0 : 1;
      const other = first === 0 ? 1 : 0;
      const one = panelAt(slot.arrive[first]);
      expect(one.panels[first]).toMatchObject({
        thinking: false,
        choice: lineOf(turn, first).choice,
        verdict: null,
      });
      expect(one.panels[other].thinking).toBe(true);
      expect(one.ticker[0]).toMatchObject({ seat: first, verdict: null });
      // Scored: both answers with their verdicts, in the panels and the ticker, nothing revealed.
      for (const f of [slot.scoreStart, slot.end - 1]) {
        const m = panelAt(f);
        expect(tl.at(f).scene).toMatchObject({ phase: 'score', reveal: 0 });
        for (const seat of [0, 1] as const) {
          expect(m.panels[seat]).toMatchObject({
            thinking: false,
            choice: lineOf(turn, seat).choice,
            verdict: verdictOf(lineOf(turn, seat)),
          });
        }
        expect(m.ticker.slice(0, 2).map((e) => e.verdict)).not.toContain(null);
      }
    }
  });

  it('the score phase shows the step’s answers, although the turn already counts as played', () => {
    const slot = slotOf(4);
    const f = tl.at(slot.scoreStart);
    expect(f.tick).toBe(5);
    // Turn 5's requests are out at tick 5 by the log alone, but its prompt hasn't come up yet.
    const generic = inFlightAt(log.decisions, f.tick, header.cadence);
    expect(generic.map((o) => o?.sentTick)).toEqual([5, 5]);
    expect(f.inFlight).toEqual([null, null]);
    expect(panelAt(slot.scoreStart).panels.map((p) => p.thinking)).toEqual([false, false]);
    // From its prompt on, they are.
    expect(tl.at(slot.end).inFlight?.map((o) => o?.sentTick)).toEqual([5, 5]);
  });

  it('step 3: the verdicts stay up through the reveal; the next word asks with them as previous', () => {
    const slot = slotOf(2);
    if (slot.revealStart === null) throw new Error('no reveal after a third step');
    for (const f of [slot.revealStart, slot.end - 1]) {
      expect(tl.at(f).scene.phase).toBe('reveal');
      expect(tl.at(f).scene.reveal).toBeGreaterThan(0);
      const m = panelAt(f);
      for (const seat of [0, 1] as const) {
        const d = lineOf(2, seat);
        expect(m.panels[seat]).toMatchObject({
          thinking: false,
          choice: d.choice,
          verdict: verdictOf(d),
        });
        expect(m.panels[seat].verdict).not.toBeNull();
      }
    }
    const next = panelAt(slotOf(3).start);
    for (const seat of [0, 1] as const) {
      const d = lineOf(2, seat);
      expect(next.panels[seat]).toMatchObject({
        thinking: true,
        previous: { choiceLabel: d.choice, status: 'ok', verdict: verdictOf(d) },
      });
    }
  });

  it('a timeout: thinking until it lands at the cap, then the status and no verdict', () => {
    const slot = slotOf(5);
    expect(lineOf(5, 1).status).toBe('timeout');
    expect(panelAt(slot.arrive[1] - 1).panels[1].thinking).toBe(true);
    const scored = panelAt(slot.scoreStart);
    expect(scored.panels[1]).toMatchObject({ thinking: false, status: 'timeout', verdict: null });
    expect(tl.at(slot.scoreStart).scene.seats[1].marks[2]).toBe('miss');
  });

  it('the last frame shows each seat’s last answer with its verdict, nothing thinking', () => {
    const end = panelAt(tl.frames - 1);
    expect(tl.at(tl.frames - 1).inFlight).toEqual([null, null]);
    for (const p of end.panels) expect(p.thinking).toBe(false);
    const lastLines = [0, 1].map((seat) => log.decisions.filter((d) => d.seat === seat).at(-1));
    for (const seat of [0, 1] as const) {
      const d = lastLines[seat];
      const want =
        d?.status === 'ok' && typeof d.correct === 'boolean'
          ? d.correct
            ? 'right'
            : 'wrong'
          : null;
      expect(end.panels[seat].verdict).toBe(want);
    }
  });

  it('is a pure function of the frame: the same panel however the frame was reached', () => {
    for (const n of [(slots[5]?.answerStart ?? 0) + 10, slots[4]?.scoreStart ?? 0]) {
      const direct = framePanel(createCluesTimeline(log).at(n), header, cluesRenderer);
      tl.at(tl.frames - 1);
      expect(panelAt(n)).toEqual(direct);
    }
  });
});

describe('panelHeaderOf', () => {
  it('reads labels, colors, cadence and warm-up spend from a log header', () => {
    const header = {
      cadence: { kind: 'realtime', tickRate: 60 },
      seats: [
        {
          player: 'jev',
          label: 'Jev (TypeSafe)',
          warmup: { latencyMs: 1, status: 'ok', costUsd: 0.003 },
        },
        { player: 'random', label: 'Random (uniform)', warmup: null },
      ],
    } as unknown as HeaderLine;
    expect(panelHeaderOf(header)).toEqual({
      labels: ['Jev (TypeSafe)', 'Random (uniform)'],
      colors: [MODEL_COLORS['jev'], NEUTRAL_COLORS[1]],
      cadence: { kind: 'realtime', tickRate: 60 },
      warmupCostUsd: [0.003, 0],
    });
  });

  it('colors each seat by its model, whichever seat it sits in', () => {
    const header = (a: string, b: string) =>
      ({
        cadence: { kind: 'realtime', tickRate: 60 },
        seats: [
          { player: a, label: a, warmup: null },
          { player: b, label: b, warmup: null },
        ],
      }) as unknown as HeaderLine;
    const jev = MODEL_COLORS['jev'];
    const openai = MODEL_COLORS['openai'];
    expect(panelHeaderOf(header('jev', 'openai')).colors).toEqual([jev, openai]);
    expect(panelHeaderOf(header('openai', 'jev')).colors).toEqual([openai, jev]);
    // Baselines keep neutral colors, never a model's.
    expect(panelHeaderOf(header('random', 'scripted')).colors).toEqual(NEUTRAL_COLORS);
    const m = panelModel(
      [line({ seat: 0, appliedTick: 1 }), line({ seat: 1, appliedTick: 2 })],
      5,
      panelHeaderOf(header('openai', 'jev')),
      OPTS,
    );
    expect(m.panels.map((p) => p.color)).toEqual([openai, jev]);
    expect(m.ticker.map((t) => [t.seat, t.color])).toEqual([
      [1, jev],
      [0, openai],
    ]);
  });
});
