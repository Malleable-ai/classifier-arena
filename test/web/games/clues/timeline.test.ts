import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMatchLog, type MatchLog } from '../../../../src/core/log/read.js';
import type { DecisionLine } from '../../../../src/core/log/schema.js';
import { createReplayCursor } from '../../../../src/core/replay/replay.js';
import { matchesDir } from '../../../../src/core/results/paths.js';
import { cluesGame } from '../../../../src/games/clues/game.js';
import {
  ANSWER_CAP_FRAMES,
  END_FRAMES,
  POP_FRAMES,
  PROMPT_FRAMES,
  REVEAL_FRAMES,
  SCORE_MIN_FRAMES,
  SHADE_FRAMES,
  STEP_MIN_FRAMES,
  createCluesTimeline,
  latencyFrames,
  locateFrame,
  markOf,
  scheduleTurns,
  turnsPlayed,
  type CluePhase,
  type Schedule,
} from '../../../../src/web/games/clues/timeline.js';
import { syntheticCluesLog } from './synthetic.js';

const DIR = matchesDir('clues');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();
const committed = files.map((f) => [f, parseMatchLog(readFileSync(join(DIR, f), 'utf8'))] as const);

/** `n` turns, every seat answering in `ms`. */
const even = (n: number, ms: number) =>
  Array.from({ length: n }, () => [ms, ms] as [number, number]);

/**
 * On every frame, each seat's request in flight is its line for the step on screen from the step's
 * prompt until its answer lands (seq, question key and sent turn only), and nothing in the score
 * phase, the reveal or the end hold.
 */
function expectStepInFlight(log: MatchLog): void {
  const tl = createCluesTimeline(log);
  for (let n = 0; n < tl.frames; n++) {
    const f = tl.at(n);
    const { phase, turn } = f.scene;
    const slot = tl.schedule.slots[turn];
    for (const seat of [0, 1] as const) {
      const asked = (phase === 'prompt' || phase === 'answer') && n < (slot?.arrive[seat] ?? 0);
      const d = log.decisions.find((l) => l.seat === seat && l.sentTick === turn);
      const want =
        asked && d !== undefined
          ? { seq: d.seq, questionKey: d.questionKey, sentTick: turn }
          : null;
      expect(f.inFlight?.[seat], `frame ${String(n)} seat ${String(seat)}`).toEqual(want);
    }
  }
}

describe('latency scaling', () => {
  it('maps a logged latency to frames 1:1 in time (60 fps), capped at 1 s', () => {
    expect(latencyFrames(0)).toBe(0);
    expect(latencyFrames(200)).toBe(12);
    expect(latencyFrames(16.7)).toBe(1);
    expect(latencyFrames(450)).toBe(27);
    expect(latencyFrames(1000)).toBe(ANSWER_CAP_FRAMES);
    expect(latencyFrames(1800)).toBe(ANSWER_CAP_FRAMES);
    expect(ANSWER_CAP_FRAMES).toBe(60);
  });

  it('puts an answer with no latency (no line) at the cap, and a negative one at 0', () => {
    expect(latencyFrames(null)).toBe(ANSWER_CAP_FRAMES);
    expect(latencyFrames(Number.NaN)).toBe(ANSWER_CAP_FRAMES);
    expect(latencyFrames(-5)).toBe(0);
  });
});

describe('turn schedule', () => {
  it('lays a step out as prompt 0.3 s, answers at their latency, then the score, 1.2 s at least', () => {
    expect([PROMPT_FRAMES, SCORE_MIN_FRAMES, STEP_MIN_FRAMES, REVEAL_FRAMES]).toEqual([
      18, 24, 72, 90,
    ]);
    const { slots, frames } = scheduleTurns([[200, 500]]);
    expect(slots).toEqual([
      {
        turn: 0,
        word: 0,
        step: 1,
        start: 0,
        answerStart: 18,
        arrive: [30, 48],
        scoreStart: 48,
        revealStart: null,
        end: 72,
      },
    ]);
    expect(frames).toBe(72 + END_FRAMES);
  });

  it('holds the score at least 0.4 s after a slow answer', () => {
    const [slot] = scheduleTurns([[900, 1000]]).slots;
    expect(slot?.scoreStart).toBe(18 + 60);
    expect(slot?.end).toBe(18 + 60 + SCORE_MIN_FRAMES);
  });

  it('reveals the word after its third step, 1.5 s, and starts each turn where the last ended', () => {
    const { slots } = scheduleTurns([
      [100, 100],
      [900, 300],
      [null, 50],
      [100, 100],
    ]);
    expect(slots.map((s) => [s.word, s.step])).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 1],
    ]);
    expect(slots.map((s) => s.start)).toEqual([0, slots[0]?.end, slots[1]?.end, slots[2]?.end]);
    expect(slots[1]?.scoreStart).toBe((slots[1]?.answerStart ?? 0) + 54);
    // A missing line lands at the cap.
    expect(slots[2]?.arrive[0]).toBe((slots[2]?.answerStart ?? 0) + ANSWER_CAP_FRAMES);
    expect(slots[2]?.revealStart).toBe((slots[2]?.scoreStart ?? 0) + SCORE_MIN_FRAMES);
    expect(slots[2]?.end).toBe((slots[2]?.revealStart ?? 0) + REVEAL_FRAMES);
    expect(slots.filter((s) => s.revealStart !== null).map((s) => s.turn)).toEqual([2]);
  });

  it('plays a word in about 5.1 s and a match in about 80 s at typical latencies', () => {
    const word = scheduleTurns(even(3, 300));
    expect((word.frames - END_FRAMES) / 60).toBeCloseTo(5.1, 5);
    for (const ms of [150, 300, 500]) {
      const match = scheduleTurns(even(48, ms));
      expect(match.frames).toBe(16 * (3 * STEP_MIN_FRAMES + REVEAL_FRAMES) + END_FRAMES);
    }
    const match = scheduleTurns(even(48, 300));
    expect(match.frames / 60).toBeGreaterThan(78);
    expect(match.frames / 60).toBeLessThan(86);
    // Slow seats stretch it: every answer at the 1 s cap is about 1.7 s a step.
    expect(scheduleTurns(even(48, 1000)).frames / 60).toBeLessThan(110);
  });
});

describe('frame → turn and phase', () => {
  const schedule: Schedule = scheduleTurns([
    [200, 500],
    [1000, 100],
    [300, 300],
  ]);
  const [s0, s1, s2] = schedule.slots;
  if (!s0 || !s1 || !s2 || s2.revealStart === null) throw new Error('unreachable');
  const reveal2 = s2.revealStart;
  const at = (n: number) => {
    const p = locateFrame(schedule, n);
    return [p.turn, p.phase, p.phaseFrame] as const;
  };

  it('finds every phase at its first and last frame', () => {
    const cases: [number, number, CluePhase, number][] = [
      [0, 0, 'prompt', 0],
      [17, 0, 'prompt', 17],
      [18, 0, 'answer', 0],
      [47, 0, 'answer', 29],
      [48, 0, 'score', 0],
      [71, 0, 'score', 23],
      [s1.start, 1, 'prompt', 0],
      [s1.scoreStart, 1, 'score', 0],
      [s2.scoreStart, 2, 'score', 0],
      [reveal2, 2, 'reveal', 0],
      [s2.end - 1, 2, 'reveal', REVEAL_FRAMES - 1],
      [s2.end, 2, 'end', 0],
      [schedule.frames - 1, 2, 'end', END_FRAMES - 1],
    ];
    for (const [frame, turn, phase, phaseFrame] of cases) {
      expect(at(frame), `frame ${String(frame)}`).toEqual([turn, phase, phaseFrame]);
    }
  });

  it('gives each phase its length', () => {
    expect(locateFrame(schedule, 0).phaseFrames).toBe(PROMPT_FRAMES);
    expect(locateFrame(schedule, 20).phaseFrames).toBe(30);
    expect(locateFrame(schedule, 50).phaseFrames).toBe(24);
    expect(locateFrame(schedule, reveal2).phaseFrames).toBe(REVEAL_FRAMES);
    expect(locateFrame(schedule, s2.end).phaseFrames).toBe(END_FRAMES);
  });

  it('clamps to the schedule', () => {
    expect(locateFrame(schedule, -10).frame).toBe(0);
    expect(locateFrame(schedule, 1e9).frame).toBe(schedule.frames - 1);
    expect(locateFrame(schedule, 12.7).frame).toBe(12);
  });

  it('counts a turn as played from its score phase on, through its reveal', () => {
    const played = (n: number) => turnsPlayed(locateFrame(schedule, n), 3);
    expect(played(0)).toBe(0);
    expect(played(s0.scoreStart - 1)).toBe(0);
    expect(played(s0.scoreStart)).toBe(1);
    expect(played(s1.start)).toBe(1);
    expect(played(s2.scoreStart)).toBe(3);
    expect(played(reveal2)).toBe(3);
    expect(played(schedule.frames - 1)).toBe(3);
  });

  it('handles a schedule with no turns', () => {
    const empty = scheduleTurns([]);
    expect(empty.frames).toBe(END_FRAMES);
    expect(locateFrame(empty, 5)).toMatchObject({ turn: 0, phase: 'end', slot: null });
  });
});

describe('marks', () => {
  const line = (over: Partial<DecisionLine>): DecisionLine => ({
    type: 'decision',
    seat: 0,
    seq: 0,
    questionKey: 't0',
    sentTick: 0,
    appliedTick: 0,
    latencyMs: 200,
    choice: 'eel',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'ok',
    ...over,
  });

  it('marks a step right, wrong, or a miss', () => {
    expect(markOf(line({ correct: true }))).toBe('right');
    expect(markOf(line({ correct: false }))).toBe('wrong');
    expect(markOf(line({ status: 'timeout', choice: null }))).toBe('miss');
    expect(markOf(line({ status: 'error', choice: null, error: 'http 500' }))).toBe('miss');
    expect(markOf(null)).toBe('miss');
  });
});

describe.each(committed)('committed log %s', (_f, log) => {
  const tl = createCluesTimeline(log);
  const end = log.matchEnd;

  it('has the schedule of its logged latencies and ends on the final hash', () => {
    expect(end).not.toBeNull();
    expect(tl.turns).toBe(end?.totalTicks);
    expect(tl.turns).toBe(48);
    expect(tl.schedule.slots).toHaveLength(48);
    expect(tl.frames).toBe(tl.schedule.frames);
    const last = tl.at(tl.frames - 1);
    expect(last.tick).toBe(end?.totalTicks);
    expect(tl.hash()).toBe(end?.finalStateHash);
    expect(last.scene.outcome?.scores).toEqual(end?.scores);
    expect(last.scene.outcome?.winner).toBe(end?.winner);
  });

  it('keeps tick = turns played = state.turn, matching the core replay cursor', () => {
    const cursor = createReplayCursor(log, cluesGame);
    for (let n = 0; n < tl.frames; n += 37) {
      const f = tl.at(n);
      expect(f.state.turn).toBe(f.tick);
      cursor.stepTo(f.tick);
      expect(tl.hash()).toBe(cursor.hash());
      // The turn on screen is the one being played; from its score on, it counts as played.
      const scoredYet = ['score', 'reveal', 'end'].includes(f.scene.phase);
      expect(f.scene.turn).toBe(scoredYet ? f.tick - 1 : f.tick);
    }
  });

  it('has a request out from each step’s prompt until its answer lands, none while scored or revealed', () => {
    expectStepInFlight(log);
  });

  it('shows the board words in board order, the asked word as the answer, revealed in steps', () => {
    const f = tl.at(0);
    expect(f.scene.words).toHaveLength(16);
    expect(f.scene.words).toContain(f.scene.answer);
    const reveal = log.events.find((e) => e.game.kind === 'reveal');
    expect(reveal?.tick).toBe(2);
    expect(reveal?.game.answer).toBe(f.scene.answer);
    const n = f.scene.tokens.length;
    const shown = [0, 1, 2].map((t) => {
      const slot = tl.schedule.slots[t];
      return slot ? tl.at(slot.start).scene.shownTokens : -1;
    });
    expect(shown).toEqual([Math.ceil(n / 3), Math.ceil((2 * n) / 3), n]);
  });
});

describe('timeline on a log with probabilities, latencies and misses', () => {
  let log: MatchLog;
  beforeAll(async () => {
    log = await syntheticCluesLog();
  });

  it('lands each seat on its board at its own latency, with the panel decisions in step', () => {
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots.find((s) => s.arrive[1] - s.arrive[0] >= 10);
    if (!slot) throw new Error('no turn where seat 0 answers first');
    const t = slot.turn;

    const before = tl.at(slot.arrive[0] - 1);
    expect(before.scene.phase).toBe('answer');
    expect(before.scene.seats.map((s) => s.arrived)).toEqual([false, false]);
    expect(before.decisions.some((d) => d.sentTick === t)).toBe(false);

    const first = tl.at(slot.arrive[0]);
    const [s0, s1] = first.scene.seats;
    expect(s0.arrived).toBe(true);
    expect(s0.shade).toBeCloseTo(1 / SHADE_FRAMES);
    expect(s0.choice).not.toBeNull();
    expect(s0.probabilities).not.toBeNull();
    expect(s1.arrived).toBe(false);
    expect(s1.probabilities).toBeNull();
    // Seat 0's line joins the decisions (and the panel) now; seat 1's waits.
    expect(first.latestDecisions[0]?.sentTick).toBe(t);
    expect(first.decisions.filter((d) => d.sentTick === t).map((d) => d.seat)).toEqual([0]);
    expect(first.tick).toBe(t);

    expect(tl.at(slot.arrive[0] + SHADE_FRAMES).scene.seats[0].shade).toBe(1);
    const both = tl.at(slot.scoreStart);
    expect(both.scene.phase).toBe('score');
    expect(both.latestDecisions.map((d) => d?.sentTick)).toEqual([t, t]);
  });

  it('has a request out from each step’s prompt until its answer lands, none while scored or revealed', () => {
    expectStepInFlight(log);
    // A miss is out until it lands at the cap.
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots[5];
    if (!slot) throw new Error('no turn 5');
    expect(tl.at(slot.arrive[1] - 1).inFlight?.[1]?.sentTick).toBe(5);
    expect(tl.at(slot.arrive[1]).inFlight).toEqual([null, null]);
  });

  it('keeps the last step’s shading until the next step’s answer lands', () => {
    const tl = createCluesTimeline(log);
    // A word's second step where seat 0 answered ok on both steps.
    const slot = tl.schedule.slots.find((s) => {
      if (s.step !== 2) return false;
      const f = tl.at(s.scoreStart);
      return f.scene.seats[0].prevProbabilities !== null && f.scene.seats[0].probabilities;
    });
    if (!slot) throw new Error('no second step with two answers');
    const prevSlot = tl.schedule.slots[slot.turn - 1];
    if (!prevSlot) throw new Error('unreachable');
    const prevProbs = tl.at(prevSlot.scoreStart).scene.seats[0].probabilities;
    const asked = tl.at(slot.start).scene.seats[0];
    expect(asked.arrived).toBe(false);
    expect(asked.prevProbabilities).toEqual(prevProbs);
    expect(asked.probabilities).toBeNull();
    // Step 1 of a word starts from a blank board.
    expect(tl.at(0).scene.seats[0].prevProbabilities).toBeNull();
  });

  it('scores each step after both answers: the score ticks up, +1 pops, the step is marked', () => {
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots.find((s) => {
      const f = tl.at(s.scoreStart);
      return f.scene.scored[0] || f.scene.scored[1];
    });
    if (!slot) throw new Error('nobody scored');
    const held = tl.at(slot.scoreStart - 1);
    const scored = tl.at(slot.scoreStart);
    expect(held.scene.phase).toBe('answer');
    expect(scored.scene.phase).toBe('score');
    expect(scored.tick).toBe(held.tick + 1);
    expect(scored.scene.scoreTick).toBeCloseTo(1 / POP_FRAMES);
    expect(tl.at(slot.scoreStart + POP_FRAMES).scene.scoreTick).toBe(1);
    const gained = [0, 1].map((s) => (scored.scene.scored[s] ? 1 : 0));
    expect(scored.scene.scores).toEqual([
      held.scene.scores[0] + (gained[0] ?? 0),
      held.scene.scores[1] + (gained[1] ?? 0),
    ]);
    expect(scored.scene.scores).toEqual(scored.state.scores);
    for (const seat of [0, 1] as const) {
      const step = slot.step - 1;
      expect(held.scene.seats[seat].marks[step]).toBeNull();
      expect(scored.scene.seats[seat].marks[step]).toBe(
        scored.scene.scored[seat] ? 'right' : scored.scene.seats[seat].miss ? 'miss' : 'wrong',
      );
    }
    // Nothing is revealed until the word's third step is scored.
    if (slot.step < 3) expect(scored.scene.reveal).toBe(0);
  });

  it('reveals the right word after the third step', () => {
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots[2];
    if (slot?.revealStart === null || slot === undefined) throw new Error('no reveal on turn 2');
    expect(tl.at(slot.revealStart - 1).scene).toMatchObject({ phase: 'score', reveal: 0 });
    const reveal = tl.at(slot.revealStart);
    expect(reveal.scene.phase).toBe('reveal');
    expect(reveal.scene.reveal).toBeGreaterThan(0);
    expect(tl.at(slot.revealStart + 20).scene.reveal).toBe(1);
    expect(reveal.scene.seats.every((s) => s.marks.every((m) => m !== null))).toBe(true);
    expect(reveal.tick).toBe(3);
  });

  it('shows a timeout as a miss with no pick', () => {
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots[5];
    if (!slot) throw new Error('no turn 5');
    expect(slot.arrive[1]).toBe(slot.answerStart + ANSWER_CAP_FRAMES);
    const f = tl.at(slot.scoreStart + 2);
    expect(f.scene.seats[1]).toMatchObject({ miss: true, choice: null, probabilities: null });
    expect(f.scene.seats[1].line?.status).toBe('timeout');
    expect(f.scene.seats[1].marks[2]).toBe('miss');
    expect(f.scene.seats[0].miss).toBe(false);
  });

  it('draws the same frame whether played up to or jumped to', () => {
    const played = createCluesTimeline(log);
    let last = played.at(0);
    for (let n = 0; n <= 900; n++) last = played.at(n);
    const jumped = createCluesTimeline(log).at(900);
    expect(jumped).toEqual(last);
  });
});
