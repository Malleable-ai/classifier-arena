import { describe, expect, it } from 'vitest';
import type { ResultsIndexEntry } from '../../../src/core/replay/results-index.js';
import {
  chooseMatch,
  CUT_SPECS,
  cutPieces,
  cutSeconds,
  type GameSegment,
} from '../../../src/cli/video/plan.js';
import { CARD_FRAMES } from '../../../src/web/cards/timeline.js';

const BASELINES = new Set(['random', 'scripted']);

function entry(
  id: string,
  players: [string, string],
  valid = true,
  game = 'fighter',
): ResultsIndexEntry {
  return {
    id,
    game,
    file: `${game}/matches/${id}.jsonl`,
    players,
    labels: players,
    winner: players[0],
    winnerSeat: 0,
    scores: [2, 1],
    valid,
    featured: false,
    seed: 1,
    startTime: '2026-10-08T00:00:00.000Z',
    totalTicks: 100,
    finalStateHash: '0',
    costUsd: 0,
  };
}

describe('chooseMatch', () => {
  const index = [
    entry('a-1', ['random', 'scripted']),
    entry('b-1', ['jev', 'openai'], false),
    entry('c-1', ['openai', 'jev']),
    entry('d-1', ['jev', 'openai']),
    entry('e-1', ['jev', 'jev']),
    entry('f-1', ['jev', 'openai'], true, 'inbox'),
  ];
  const ids = ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'];

  it('takes the featured match when its log exists', () => {
    expect(chooseMatch('fighter', BASELINES, { fighter: 'd-1' }, index, ids)).toEqual({
      id: 'd-1',
      why: 'featured',
    });
  });

  it('else the first valid head-to-head of that game (two different models)', () => {
    expect(chooseMatch('fighter', BASELINES, { fighter: 'gone-1' }, index, ids)).toEqual({
      id: 'c-1',
      why: 'head-to-head',
    });
  });

  it('else, for development, the first committed log; null without logs', () => {
    const baselinesOnly = [entry('a-1', ['random', 'scripted'])];
    expect(chooseMatch('fighter', BASELINES, {}, baselinesOnly, ['z-1', 'a-1'])).toEqual({
      id: 'a-1',
      why: 'any',
    });
    expect(chooseMatch('clues', BASELINES, {}, index, [])).toBeNull();
  });
});

describe('cutPieces', () => {
  const seg = (game: string, from: number, to: number): GameSegment => ({
    game,
    choice: { id: `${game}-1`, why: 'featured' },
    window: { from, to, score: 1 },
  });
  const frames = (name: string): number =>
    name === 'intro' ? CARD_FRAMES.intro : name === 'outro' ? CARD_FRAMES.outro : CARD_FRAMES.title;

  it('plays intro → (title → segment) per game → outro', () => {
    const pieces = cutPieces([seg('fighter', 0, 60), seg('clues', 100, 160)], frames);
    expect(pieces.map((p) => (p.kind === 'card' ? p.name : `${p.game}:${p.id}`))).toEqual([
      'intro',
      'title-fighter',
      'fighter:fighter-1',
      'title-clues',
      'clues:clues-1',
      'outro',
    ]);
    expect(cutSeconds(pieces)).toBeCloseTo(4 + 1.5 + 1 + 1.5 + 1 + 7.5);
  });

  it('a square cut of three games at the segment length lands in 45–60 s', () => {
    const len = CUT_SPECS.square.segmentS * 60;
    const pieces = cutPieces(
      [
        seg('fighter', 0, len),
        seg('inbox', 0, len),
        seg('clues', 0, CUT_SPECS.square.turnMaxS * 60),
      ],
      frames,
    );
    expect(cutSeconds(pieces)).toBeGreaterThanOrEqual(45);
    expect(cutSeconds(pieces)).toBeLessThanOrEqual(60);
    // Even with a turn window one turn (~2.7 s) shorter.
    const short = cutPieces(
      [
        seg('fighter', 0, len),
        seg('inbox', 0, len),
        seg('clues', 0, (CUT_SPECS.square.turnMaxS - 2.7) * 60),
      ],
      frames,
    );
    expect(cutSeconds(short)).toBeGreaterThanOrEqual(45);
  });

  it('the cuts are square 1080 and wide 1920x1080, the wide one fuller', () => {
    expect(CUT_SPECS.square.size).toEqual({ width: 1080, height: 1080 });
    expect(CUT_SPECS.wide.size).toEqual({ width: 1920, height: 1080 });
    expect(CUT_SPECS.wide.segmentS).toBeGreaterThanOrEqual(25);
    expect(CUT_SPECS.wide.segmentS).toBeLessThanOrEqual(40);
    expect(CUT_SPECS.square.segmentS).toBeGreaterThanOrEqual(12);
    expect(CUT_SPECS.square.segmentS).toBeLessThanOrEqual(15);
    expect(CUT_SPECS.square.out).toBe('renders/arena-square.mp4');
    expect(CUT_SPECS.wide.out).toBe('renders/arena-wide.mp4');
  });
});
