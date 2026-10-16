import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Seat } from '../../../../src/core/classifier/types.js';
import { parseMatchLog, type MatchLog } from '../../../../src/core/log/read.js';
import type { EventLine } from '../../../../src/core/log/schema.js';
import { createReplayCursor } from '../../../../src/core/replay/replay.js';
import { END_HOLD_FRAMES } from '../../../../src/web/shell/frames.js';
import { matchesDir } from '../../../../src/core/results/paths.js';
import { inboxGame } from '../../../../src/games/inbox/game.js';
import { FAST, SLOW, runInboxMatch } from '../../../../src/games/inbox/tune.js';
import { rendererFor } from '../../../../src/web/games/index.js';
import {
  laneCards,
  laneResolutions,
  lastHit,
  pulseAt,
} from '../../../../src/web/games/inbox/model.js';
import {
  CHAPTER_GAP_TICKS,
  createInboxTimeline,
  EVENT_LEAD_TICKS,
  inboxChapters,
  inboxRenderer,
} from '../../../../src/web/games/inbox/renderer.js';

const DIR = matchesDir('inbox');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();
const logs = files.map((f) => parseMatchLog(readFileSync(join(DIR, f), 'utf8')));
const log = logs[0];
if (log === undefined) throw new Error('no committed inbox logs');

/** Every card that shows up answered (age 0) or landed (age 0) while playing the whole log. */
function verdictsOver(l: MatchLog, seat: Seat) {
  const tl = createInboxTimeline(l);
  const seen = { cleared: 0, wrong: 0, landed: 0 };
  let last = -1;
  for (let t = 0; t < tl.frames; t++) {
    const f = tl.at(t);
    // The end hold repeats the last tick: count each tick once.
    if (f.tick === last) continue;
    last = f.tick;
    for (const c of laneCards(f.state, seat, laneResolutions(f.decisions, seat), f.tick)) {
      if (c.phase !== 'falling' && c.age === 0) seen[c.phase]++;
    }
  }
  return { seen, lane: tl.at(tl.frames - 1).state.lanes[seat] };
}

describe('inbox timeline', () => {
  it('has one frame per tick, 0 … totalTicks, then holds the last tick for END_HOLD_FRAMES', () => {
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const tl = createInboxTimeline(log);
    const total = log.matchEnd?.totalTicks ?? 0;
    expect(tl.frames).toBe(total + 1 + END_HOLD_FRAMES);
    const held = tl.at(total + 100);
    expect(held.frame).toBe(total + 100);
    expect(held.tick).toBe(total);
    expect(held.state.over).toBe(true);
    expect(createInboxTimeline({ ...log, matchEnd: null }).frames).toBeLessThanOrEqual(total + 1);
  });

  it.each(files.map((f, i) => [f, logs[i]] as const))(
    '%s: the last frame reaches the recorded final hash; frames clamp',
    (_f, l) => {
      const tl = createInboxTimeline(l as MatchLog);
      const end = l?.matchEnd;
      expect(tl.at(1e9).frame).toBe((end?.totalTicks ?? 0) + END_HOLD_FRAMES);
      expect(tl.at(1e9).tick).toBe(end?.totalTicks);
      expect(tl.hash()).toBe(end?.finalStateHash);
      expect(tl.at(1e9).state.over).toBe(true);
      expect(tl.at(-4).frame).toBe(0);
    },
  );

  it('jumping to a tick gives the same frame as playing up to it, forwards and back', () => {
    const played = createInboxTimeline(log);
    const jumped = createInboxTimeline(log);
    for (let t = 0; t <= 1500; t++) {
      const p = played.at(t);
      if (t % 211 !== 0) continue;
      const j = jumped.at(t);
      expect(jumped.hash()).toBe(played.hash());
      expect(j.decisions).toEqual(p.decisions);
      expect(j.events).toEqual(p.events);
      expect(j.state).toEqual(p.state);
    }
    expect(jumped.at(300).state).toEqual(createInboxTimeline(log).at(300).state);
  });

  it('gives the same states as the core replay cursor', () => {
    const tl = createInboxTimeline(log);
    const cursor = createReplayCursor(log, inboxGame);
    for (const t of [0, 1, 333, 900, 1500]) {
      tl.at(t);
      cursor.stepTo(t);
      expect(tl.hash()).toBe(cursor.hash());
    }
  });

  it('fills frames from the log: labels, resolved decisions, latest per seat, past events', () => {
    const tl = createInboxTimeline(log);
    const f = tl.at(600);
    expect(f.labels).toEqual([log.header.seats[0].label, log.header.seats[1].label]);
    expect(f.tick).toBe(600);
    expect(f.state.tick).toBe(600);
    expect(f.decisions.length).toBeGreaterThan(0);
    expect(f.decisions.every((d) => (d.appliedTick ?? Infinity) <= 600)).toBe(true);
    expect(f.events.every((e) => e.tick < 600)).toBe(true);
    for (const seat of [0, 1] as const) {
      const mine = f.decisions.filter((d) => d.seat === seat);
      expect(f.latestDecisions[seat]).toEqual(mine[mine.length - 1] ?? null);
    }
    expect(tl.at(0).decisions).toEqual([]);
    expect(tl.at(1e9).events.map((e) => e.game.kind)).toContain('game_over');
  });

  it.each([0, 1] as const)(
    'seat %i: every answer the game applied shows as a cleared or wrong card, once',
    (seat) => {
      const { seen, lane } = verdictsOver(log, seat);
      expect(seen.cleared).toBe(lane.cleared);
      expect(seen.wrong).toBe(lane.wrong);
      expect(seen.landed).toBe(lane.landed);
      expect(seen.cleared + seen.wrong).toBeGreaterThan(0);
    },
  );
});

describe('inbox stage with landings (a simulated 180 ms vs 300 ms match)', async () => {
  // The slow seat falls behind after about a minute and messages land in its lane.
  const run = await runInboxMatch(3, [FAST, SLOW]);
  const sim = parseMatchLog(run.lines.map((l) => JSON.stringify(l)).join('\n'));

  it('replays to its final hash', () => {
    const tl = createInboxTimeline(sim);
    tl.at(1e9);
    expect(tl.hash()).toBe(run.end.finalStateHash);
  });

  it('shows every landing as a landed card on its land tick, and pulses the inbox', () => {
    const { seen, lane } = verdictsOver(sim, 1);
    expect(lane.landed).toBeGreaterThan(0);
    expect(seen.landed).toBe(lane.landed);
    expect(seen.cleared).toBe(lane.cleared);
    expect(seen.wrong).toBe(lane.wrong);

    const first = sim.events.find((e) => e.game.kind === 'hit' && e.game.cause === 'landed');
    if (first === undefined) throw new Error('no landing');
    const f = createInboxTimeline(sim).at(first.tick + 1);
    const cards = laneCards(f.state, 1, laneResolutions(f.decisions, 1), f.tick);
    const landed = cards.find((c) => c.phase === 'landed' && c.id === first.game.id);
    expect(landed?.age).toBe(0);
    // Drawn last: on top of the pile it fell out of.
    expect(cards[cards.length - 1]).toBe(landed);
    const hit = lastHit(f.events, 1);
    expect(hit?.cause).toBe('landed');
    expect(pulseAt(hit, f.tick)).toBe(1);
  });

  it('has a chapter just before the first landing', () => {
    const first = sim.events.find((e) => e.game.kind === 'hit' && e.game.cause === 'landed');
    const c = inboxChapters(sim).find((x) => x.label === 'Landed');
    expect(c).toEqual({
      label: 'Landed',
      title: 'the first landing',
      frame: (first?.tick ?? 0) - EVENT_LEAD_TICKS,
    });
  });
});

function withEvents(events: EventLine[], totalTicks: number): MatchLog {
  if (log === undefined || log.matchEnd === null) throw new Error('no log');
  return { ...log, events, matchEnd: { ...log.matchEnd, totalTicks } };
}

const hitAt = (tick: number, cause: 'wrong' | 'landed'): EventLine => ({
  type: 'event',
  tick,
  game: { kind: 'hit', seat: 0, id: 'x', cause, damage: 1, health: 99 },
});

describe('inbox chapters', () => {
  it('marks the start, the first hit, the first landing and every 30 s', () => {
    const l = withEvents([hitAt(600, 'wrong'), hitAt(700, 'wrong'), hitAt(2400, 'landed')], 4000);
    expect(inboxChapters(l)).toEqual([
      { label: '0:00', title: 'the start', frame: 0 },
      { label: 'Hit', title: 'the first hit', frame: 600 - EVENT_LEAD_TICKS },
      { label: '0:30', title: '0:30', frame: 1800 },
      { label: 'Landed', title: 'the first landing', frame: 2400 - EVENT_LEAD_TICKS },
      { label: '1:00', title: '1:00', frame: 3600 },
    ]);
  });

  it('drops a chapter too close to a better one: an early hit folds into the start', () => {
    const l = withEvents([hitAt(32, 'wrong'), hitAt(3620, 'landed')], 4000);
    expect(inboxChapters(l).map((c) => c.label)).toEqual(['0:00', '0:30', 'Landed']);
  });

  it('keeps chapters apart and in order for every committed log', () => {
    for (const l of logs) {
      const frames = inboxChapters(l).map((c) => c.frame);
      expect(frames[0]).toBe(0);
      for (let i = 1; i < frames.length; i++) {
        expect((frames[i] ?? 0) - (frames[i - 1] ?? 0)).toBeGreaterThanOrEqual(CHAPTER_GAP_TICKS);
      }
      expect(Math.max(...frames)).toBeLessThan(l.matchEnd?.totalTicks ?? 0);
    }
  });

  it('runs to the last tick any line mentions when the log stopped early', () => {
    const cut: MatchLog = { ...log, matchEnd: null, events: [] };
    const lastSent = Math.max(...log.decisions.map((d) => d.appliedTick ?? d.sentTick));
    const expected = Math.ceil(lastSent / 1800) - 1;
    expect(inboxChapters(cut)).toHaveLength(1 + expected);
  });
});

describe('inbox renderer', () => {
  it('is registered for the inbox, with a 1920×1080 stage', () => {
    expect(rendererFor('inbox')).toBe(inboxRenderer);
    expect(inboxRenderer.gameId).toBe('inbox');
    expect(inboxRenderer.stage).toEqual({ width: 1920, height: 1080 });
    // The shared panel shows all three options.
    expect(inboxRenderer.probabilityBars).toBeUndefined();
  });

  it('labels the three options', () => {
    expect(['legit', 'spam', 'smishing'].map((id) => inboxRenderer.optionLabel(id))).toEqual([
      'Legit',
      'Spam',
      'Smishing',
    ]);
  });
});
