import { beforeAll, describe, expect, it } from 'vitest';
import type { MatchLog } from '../../../../src/core/log/read.js';
import type { DecisionLine } from '../../../../src/core/log/schema.js';
import { cluesGame } from '../../../../src/games/clues/game.js';
import { rendererFor } from '../../../../src/web/games/index.js';
import {
  LIVE_SCORE_HOLD,
  advanceLive,
  cluesRenderer,
  liveFrames,
  liveHoldFrames,
  liveScene,
  shownTurns,
  wordChapters,
  type LiveView,
} from '../../../../src/web/games/clues/renderer.js';
import {
  PROMPT_FRAMES,
  REVEAL_FRAMES,
  createCluesTimeline,
} from '../../../../src/web/games/clues/timeline.js';
import { frameBase } from '../../../../src/web/shell/frames.js';
import { panelTick } from '../../../../src/web/shell/stage.js';
import { syntheticCluesLog } from './synthetic.js';

let log: MatchLog;
beforeAll(async () => {
  log = await syntheticCluesLog();
});

describe('clue renderer', () => {
  it('is registered for the clue game, on a 1920 × 1080 stage', () => {
    expect(rendererFor('clues')).toBe(cluesRenderer);
    expect(cluesRenderer.stage).toEqual({ width: 1920, height: 1080 });
  });

  it('labels an option by its id (the board word)', () => {
    expect(cluesRenderer.optionLabel('halibut')).toBe('halibut');
  });

  it('jumps to the first frame of every word (its first clue)', () => {
    const chapters = wordChapters(log);
    const tl = createCluesTimeline(log);
    expect(chapters).toHaveLength(16);
    expect(chapters[0]).toEqual({ label: '1', title: 'word 1', frame: 0 });
    expect(chapters.map((c) => c.frame)).toEqual(
      tl.schedule.slots.filter((s) => s.step === 1).map((s) => s.start),
    );
    for (const [i, c] of chapters.entries()) {
      const f = tl.at(c.frame);
      expect(f.scene).toMatchObject({ word: i, step: 1, phase: 'prompt', phaseFrame: 0 });
    }
  });
});

describe('panel tick', () => {
  const line = (over: Partial<DecisionLine>): DecisionLine => ({
    type: 'decision',
    seat: 0,
    seq: 0,
    questionKey: 't3',
    sentTick: 3,
    appliedTick: 3,
    latencyMs: 200,
    choice: 'eel',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'ok',
    ...over,
  });

  it('is the frame tick unless the frame holds a decision resolved later', () => {
    const turns = { kind: 'turns' } as const;
    expect(panelTick({ tick: 3, decisions: [line({ sentTick: 2, appliedTick: 2 })] }, turns)).toBe(
      3,
    );
    // A clue turn's answer landed on its board before the turn was played.
    expect(panelTick({ tick: 3, decisions: [line({})] }, turns)).toBe(4);
    const realtime = { kind: 'realtime', tickRate: 60 } as const;
    expect(panelTick({ tick: 90, decisions: [line({ appliedTick: 80 })] }, realtime)).toBe(90);
  });
});

describe('live mode', () => {
  /** ms of `frames` frames at 60 fps. */
  const ms = (frames: number) => (frames * 1000) / 60;
  const SCORE_MS = ms(LIVE_SCORE_HOLD);
  const PROMPT_MS = ms(PROMPT_FRAMES);
  const holdMs = (turn: number) => ms(liveHoldFrames(turn));

  /** The live frame base after `k` turns, from the log's lines, as live mode builds it. */
  function baseAfter(k: number) {
    const tl = createCluesTimeline(log);
    const slot = tl.schedule.slots[k];
    const f = slot === undefined ? tl.at(tl.frames - 1) : tl.at(slot.start);
    expect(f.state.turn).toBe(k);
    return frameBase({
      frame: 0,
      tick: f.state.turn,
      state: f.state,
      labels: ['A', 'B'],
      players: ['', ''],
      cadence: { kind: 'turns' },
      decisions: log.decisions,
      events: log.events,
    });
  }

  /** Live frames on a fake clock. */
  function live() {
    let now = 1000;
    const frames = liveFrames(() => now);
    return {
      frames,
      at: (t: number) => {
        now = t;
      },
      get now() {
        return now;
      },
    };
  }

  it('holds a played step on its score, and a third step also on its reveal', () => {
    expect(liveHoldFrames(0)).toBe(LIVE_SCORE_HOLD);
    expect(liveHoldFrames(1)).toBe(LIVE_SCORE_HOLD);
    expect(liveHoldFrames(2)).toBe(LIVE_SCORE_HOLD + REVEAL_FRAMES);
  });

  it('shows the first clue while both seats think', () => {
    const state = cluesGame.create(log.header.seed, cluesGame.defaultConfig);
    const b = frameBase({
      frame: 0,
      tick: 0,
      state,
      labels: ['A', 'B'],
      players: ['', ''],
      cadence: { kind: 'turns' },
      decisions: [],
      events: [],
    });
    const view: LiveView = { turn: 0, stage: 'ask', since: 0 };
    expect(liveScene(b, view, 0)).toMatchObject({ turn: 0, step: 1, phase: 'prompt', reveal: 0 });
    const thinking = liveScene(b, view, ms(PROMPT_FRAMES + 5));
    expect(thinking.phase).toBe('answer');
    expect(thinking.seats.map((s) => s.arrived)).toEqual([false, false]);
    expect(thinking.shownTokens).toBe(Math.ceil(thinking.tokens.length / 3));
  });

  it('holds a played step on its score, then moves to the next clue with the last shading', () => {
    const clock = live();
    expect(clock.frames.frame(baseAfter(0)).scene).toMatchObject({ turn: 0, phase: 'prompt' });
    clock.at(clock.now + PROMPT_MS + 500);
    expect(clock.frames.frame(baseAfter(0)).scene.phase).toBe('answer');
    // Turn 0 is played: its score starts at once and holds LIVE_SCORE_HOLD.
    const b = baseAfter(1);
    const scoreAt = clock.now;
    const score = clock.frames.frame(b).scene;
    expect(score).toMatchObject({ turn: 0, phase: 'score', reveal: 0 });
    expect(score.seats.every((s) => s.arrived)).toBe(true);
    expect(score.seats.every((s) => s.marks[0] !== null)).toBe(true);
    clock.at(scoreAt + SCORE_MS + 1);
    const next = clock.frames.frame(b).scene;
    expect(next).toMatchObject({ turn: 1, step: 2, phase: 'prompt' });
    expect(next.scores).toEqual(b.state.scores);
    expect(next.seats[0].prevProbabilities).toEqual(score.seats[0].probabilities);
    expect(clock.frames.busy?.()).toBe(false);
  });

  it('reveals the word after its third step is played', () => {
    const clock = live();
    const b = baseAfter(3);
    const phases: string[] = [];
    const answer = log.events.find((e) => e.game.kind === 'reveal' && e.tick === 2)?.game.answer;
    for (let i = 0; i < 1_000; i++) {
      const f = clock.frames.frame(b).scene;
      const key = `${String(f.turn)} ${f.phase}`;
      if (phases.at(-1) !== key) phases.push(key);
      if (f.phase === 'reveal') expect(f.answer).toBe(answer);
      if (clock.frames.busy?.() === false) break;
      clock.at(clock.now + 16);
    }
    expect(phases).toEqual([
      '0 prompt',
      '0 score',
      '1 prompt',
      '1 score',
      '2 prompt',
      '2 score',
      '2 reveal',
      // Then it waits on turn 3, live (and is no longer busy).
      '3 prompt',
    ]);
  });

  it('holds every step its full time when turns come faster, with the panel kept in step', () => {
    const clock = live();
    const start = clock.now;
    clock.frames.frame(baseAfter(0));
    // Turns 1 to 4 are played 100 ms apart, far faster than a step is held.
    const shown: { t: number; turn: number; phase: string; tick: number; lines: number }[] = [];
    for (let t = start; t <= start + 12_000; t += 16) {
      clock.at(t);
      const played = Math.min(4, Math.floor((t - start) / 100));
      const f = clock.frames.frame(baseAfter(played));
      shown.push({
        t,
        turn: f.scene.turn,
        phase: f.scene.phase,
        tick: f.tick,
        lines: f.decisions.length,
      });
    }
    for (let turn = 0; turn < 4; turn++) {
      const held = shown.filter((s) => s.turn === turn && ['score', 'reveal'].includes(s.phase));
      const first = held[0];
      const last = held.at(-1);
      if (first === undefined || last === undefined) throw new Error(`turn ${String(turn)}`);
      expect(last.t - first.t, `turn ${String(turn)}`).toBeGreaterThanOrEqual(holdMs(turn) - 32);
      // The panel shows the turns scored so far, never the ones still to come.
      expect(held.every((s) => s.tick === turn + 1 && s.lines === 2 * (turn + 1))).toBe(true);
    }
    // Each later turn shows its clue before its score.
    expect(shown.some((s) => s.turn === 3 && s.phase === 'prompt')).toBe(true);
    // Then it waits on turn 4, live.
    expect(shown.at(-1)).toMatchObject({ turn: 4, phase: 'answer', tick: 4 });
  });

  it('plays out the last turns and ends on the result once the match is over', () => {
    const clock = live();
    clock.frames.frame(baseAfter(45));
    const last = baseAfter(48);
    expect(last.state.over).toBe(true);
    const phases: string[] = [];
    for (let i = 0; i < 20_000 && clock.frames.busy?.() !== false; i++) {
      clock.at(clock.now + 16);
      const f = clock.frames.frame(last);
      if (phases.at(-1) !== `${String(f.scene.turn)} ${f.scene.phase}`) {
        phases.push(`${String(f.scene.turn)} ${f.scene.phase}`);
      }
    }
    // The view started at turn 0, so it shows every played turn at its pace, then the result.
    for (let turn = 0; turn < 48; turn++) {
      for (const phase of ['prompt', 'score']) {
        expect(phases).toContain(`${String(turn)} ${phase}`);
      }
      if (turn % 3 === 2) expect(phases).toContain(`${String(turn)} reveal`);
    }
    expect(phases.slice(-3)).toEqual(['47 score', '47 reveal', '47 end']);
    expect(clock.frames.busy?.()).toBe(false);
    const end = clock.frames.frame(last).scene;
    expect(end.outcome?.scores).toEqual(log.matchEnd?.scores);
    expect(end.scores).toEqual(log.matchEnd?.scores);
  });

  it('advances the view on the clock, stage by stage', () => {
    const played = () => 0;
    let v: LiveView = { turn: 0, stage: 'ask', since: 0 };
    expect(advanceLive(v, 0, false, 10_000, played)).toEqual(v);
    v = advanceLive(v, 1, false, PROMPT_MS, played);
    expect(v).toEqual({ turn: 0, stage: 'held', since: PROMPT_MS });
    expect(shownTurns(v)).toBe(1);
    v = advanceLive(v, 1, false, PROMPT_MS + SCORE_MS, played);
    expect(v).toEqual({ turn: 1, stage: 'ask', since: PROMPT_MS + SCORE_MS });
    expect(shownTurns(v)).toBe(1);
    // A step is held when its turn is played, if that is after the prompt.
    expect(advanceLive({ turn: 0, stage: 'ask', since: 0 }, 1, false, 4500, () => 4000)).toEqual({
      turn: 0,
      stage: 'held',
      since: 4000,
    });
    // A third step holds through the reveal.
    expect(advanceLive({ turn: 2, stage: 'held', since: 0 }, 3, false, SCORE_MS, played)).toEqual({
      turn: 2,
      stage: 'held',
      since: 0,
    });
    expect(
      advanceLive({ turn: 47, stage: 'held', since: 0 }, 48, true, holdMs(47), played),
    ).toEqual({ turn: 47, stage: 'end', since: holdMs(47) });
  });
});
