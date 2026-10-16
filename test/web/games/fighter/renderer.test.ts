import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RealtimeInput } from '../../../../src/core/game.js';
import { parseMatchLog, type MatchLog } from '../../../../src/core/log/read.js';
import { createReplayCursor } from '../../../../src/core/replay/replay.js';
import { matchesDir } from '../../../../src/core/results/paths.js';
import { createMatch } from '../../../../src/games/fighter/engine/sim.js';
import { fighterGame, stepFighter } from '../../../../src/games/fighter/game.js';
import { rendererFor } from '../../../../src/web/games/index.js';
import {
  createFighterTimeline,
  fighterRenderer,
  roundStartTicks,
  seatLabel,
} from '../../../../src/web/games/fighter/renderer.js';
import { END_HOLD_FRAMES, frameBase } from '../../../../src/web/shell/frames.js';

const DIR = matchesDir('fighter');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();
const logs = files.map((f) => parseMatchLog(readFileSync(join(DIR, f), 'utf8')));
const log = logs[0];
if (log === undefined) throw new Error('no committed fighter logs');

describe('fighter timeline', () => {
  it('has one frame per tick, 0 … totalTicks, then holds the end for END_HOLD_FRAMES', () => {
    const tl = createFighterTimeline(log);
    const total = log.matchEnd?.totalTicks ?? 0;
    expect(tl.frames).toBe(total + 1 + END_HOLD_FRAMES);
    expect(tl.at(total - 1).tick).toBe(total - 1);
    // The hold: the frame counts on, the tick, the state and the panel's lines stay final.
    const end = tl.at(total);
    const held = tl.at(total + END_HOLD_FRAMES);
    expect(held.frame).toBe(total + END_HOLD_FRAMES);
    expect(held.tick).toBe(total);
    expect(held.state).toEqual(end.state);
    expect(held.decisions).toEqual(end.decisions);
    expect(tl.hash()).toBe(log.matchEnd?.finalStateHash);
    // A log that stopped early has no hold.
    const cut: MatchLog = { ...log, matchEnd: null };
    expect(createFighterTimeline(cut).frames).toBe(
      createReplayCursor(cut, fighterGame).lastTick + 1,
    );
  });

  it("plays the K.O. out on screen: the loser falls and stays down, the result's health stays", () => {
    const tl = createFighterTimeline(log);
    const total = log.matchEnd?.totalTicks ?? 0;
    const end = tl.at(total);
    const loser = end.state.fighters.findIndex((f) => f.health <= 0);
    if (loser < 0) return; // a timeout: nobody falls
    const held = tl.at(total + END_HOLD_FRAMES);
    const shownLoser = held.shown.fighters[loser];
    expect(shownLoser?.phase).toBe('knockdown');
    expect(shownLoser?.y).toBe(0);
    expect(held.shown.fighters.map((f) => f.health)).toEqual(
      end.state.fighters.map((f) => f.health),
    );
    expect(held.shown.status).toBe('matchOver');
    expect(held.shown.tick).toBe(end.state.tick + END_HOLD_FRAMES);
    // The replay's own state is untouched.
    expect(end.shown).toBe(end.state);
    // Same frame, same look, however it was reached.
    expect(createFighterTimeline(log).at(total + 40).shown).toEqual(tl.at(total + 40).shown);
  });

  it('settles between rounds too, while the engine only counts the pause down', () => {
    const tl = createFighterTimeline(log);
    const end1 = log.events.find((e) => e.game.kind === 'round_end');
    if (end1 === undefined || end1.tick + 30 >= (log.matchEnd?.totalTicks ?? 0)) return;
    const f = tl.at(end1.tick + 30);
    if (f.state.status !== 'roundOver') return;
    expect(f.shown).not.toBe(f.state);
    expect(f.shown.tick).toBe(f.state.tick);
    const ko = f.state.fighters.findIndex((x) => x.health <= 0);
    if (ko >= 0) expect(f.shown.fighters[ko]?.phase).toBe('knockdown');
  });

  it('jumping to a tick gives the same state, effects and decisions as playing up to it', () => {
    const played = createFighterTimeline(log);
    const jumped = createFighterTimeline(log);
    let sawEffects = false;
    for (let t = 0; t <= 1500; t++) {
      const p = played.at(t);
      if (t % 97 !== 0) continue;
      const j = jumped.at(t);
      expect(jumped.hash()).toBe(played.hash());
      expect(j.effects).toEqual(p.effects);
      expect(j.decisions).toEqual(p.decisions);
      expect(j.latestDecisions).toEqual(p.latestDecisions);
      if (p.effects.length > 0) sawEffects = true;
    }
    expect(sawEffects).toBe(true);
    // Backwards too.
    expect(jumped.at(200).effects).toEqual(createFighterTimeline(log).at(200).effects);
  });

  it('gives the same states as the core replay cursor (the effects never touch the match)', () => {
    const tl = createFighterTimeline(log);
    const cursor = createReplayCursor(log, fighterGame);
    for (const t of [0, 1, 333, 900, 1700]) {
      tl.at(t);
      cursor.stepTo(t);
      expect(tl.hash()).toBe(cursor.hash());
    }
  });

  it.each(files.map((f, i) => [f, logs[i]] as const))(
    '%s: the last frame reaches the recorded final hash; frames clamp',
    (_f, l) => {
      const tl = createFighterTimeline(l as MatchLog);
      const end = l?.matchEnd;
      expect(tl.at(1e9).frame).toBe((end?.totalTicks ?? 0) + END_HOLD_FRAMES);
      expect(tl.at(1e9).tick).toBe(end?.totalTicks);
      expect(tl.hash()).toBe(end?.finalStateHash);
      expect(tl.at(-4).frame).toBe(0);
    },
  );

  it('fills frames from the log: labels, resolved decisions, latest per seat, past events', () => {
    const tl = createFighterTimeline(log);
    const f = tl.at(600);
    expect(f.labels).toEqual([log.header.seats[0].label, log.header.seats[1].label]);
    expect(f.tick).toBe(600);
    expect(f.state.tick).toBe(600);
    expect(f.decisions.length).toBeGreaterThan(0);
    expect(f.decisions.every((d) => (d.appliedTick ?? Infinity) <= 600)).toBe(true);
    for (const seat of [0, 1] as const) {
      const mine = f.decisions.filter((d) => d.seat === seat);
      expect(f.latestDecisions[seat]).toEqual(mine[mine.length - 1] ?? null);
    }
    const last = tl.at(1e9);
    expect(last.events.map((e) => e.game.kind)).toContain('round_end');
    expect(tl.at(0).events).toEqual([]);
    expect(tl.at(0).decisions).toEqual([]);
  });
});

describe('fighter renderer', () => {
  it('is registered for the fighter', () => {
    expect(rendererFor('fighter')).toBe(fighterRenderer);
    expect(rendererFor('nope')).toBeNull();
    expect(fighterRenderer.stage).toEqual({ width: 1920, height: 1080 });
  });

  it('labels moves in plain words', () => {
    expect(fighterRenderer.optionLabel('walk_forward')).toBe('walk forward');
    expect(fighterRenderer.optionLabel('jab')).toBe('jab');
  });

  it('marks a chapter at each round start', () => {
    const starts = roundStartTicks(log);
    expect(starts[0]).toBe(0);
    const chapters = fighterRenderer.chapters(log);
    expect(chapters.map((c) => c.frame)).toEqual(starts);
    expect(chapters[0]).toEqual({ label: 'R1', title: 'round 1', frame: 0 });
    // Round 2 starts after round 1's end plus the pause.
    const end1 = log.events.find((e) => e.game.kind === 'round_end');
    const pause = log.header.config['roundPauseTicks'] as number;
    if (end1 !== undefined && starts.length > 1) expect(starts[1]).toBe(end1.tick + pause);
  });

  it('counts the round still running when the log stopped early', () => {
    const cut: MatchLog = { ...log, matchEnd: null };
    const ends = log.events.filter((e) => e.game.kind === 'round_end').length;
    expect(roundStartTicks(cut)).toHaveLength(ends + 1);
    expect(roundStartTicks(log)).toHaveLength(ends);
  });

  it('names seats "P1 · label", or just "P1" without one', () => {
    expect(seatLabel(0, 'Jev (TypeSafe)')).toBe('P1 · Jev (TypeSafe)');
    expect(seatLabel(1, '')).toBe('P2');
  });
});

describe('fighter live frames', () => {
  it('derives hit effects from each step, as the replay does', () => {
    const live = fighterRenderer.live?.();
    if (live === undefined) throw new Error('no live frames');
    // Replay the committed log tick by tick through stepFighter, handing each tick to `onStep`.
    const tl = createFighterTimeline(log);
    const inputsAt = new Map<number, [RealtimeInput | null, RealtimeInput | null]>();
    for (const d of log.decisions) {
      if (d.appliedTick === null || d.choice === null) continue;
      const pair = inputsAt.get(d.appliedTick) ?? [null, null];
      pair[d.seat] = { choice: d.choice, questionKey: d.questionKey };
      inputsAt.set(d.appliedTick, pair);
    }
    const state = createMatch(log.header.seed);
    let saw = false;
    for (let t = 0; t < 1200; t++) {
      const before = fighterGame.clone(state);
      const inputs = inputsAt.get(state.tick) ?? [null, null];
      stepFighter(state, inputs);
      live.onStep?.(before, inputs, state);
      const base = frameBase({
        frame: state.tick,
        tick: state.tick,
        state,
        labels: ['a', 'b'],
        players: ['', ''],
        cadence: log.header.cadence,
        decisions: [],
        events: [],
      });
      const frame = live.frame(base);
      expect(frame.effects).toEqual(tl.at(state.tick).effects);
      if (frame.effects.length > 0) saw = true;
    }
    expect(saw).toBe(true);
  });
});
