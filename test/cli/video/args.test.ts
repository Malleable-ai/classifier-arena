import { describe, expect, it } from 'vitest';
import {
  defaultOutPath,
  frameOf,
  frameRange,
  parseFrameSpec,
  parseRenderArgs,
  sourceFrames,
  UsageError,
} from '../../../src/cli/video/args.js';

describe('parseFrameSpec', () => {
  it('reads a frame number or seconds', () => {
    expect(parseFrameSpec('120')).toEqual({ frame: 120 });
    expect(parseFrameSpec('0')).toEqual({ frame: 0 });
    expect(parseFrameSpec('2s')).toEqual({ seconds: 2 });
    expect(parseFrameSpec(' 2.5s ')).toEqual({ seconds: 2.5 });
    expect(frameOf({ seconds: 2.5 })).toBe(150);
    expect(frameOf({ seconds: 0.01 })).toBe(1);
    expect(frameOf({ frame: 7 })).toBe(7);
  });

  it('rejects anything else, naming the flag', () => {
    for (const bad of ['', '-1', '1.5', 's', '2m', '1e3', '2 s']) {
      expect(() => parseFrameSpec(bad, 'from'), bad).toThrow(UsageError);
    }
    expect(() => parseFrameSpec('x', 'to')).toThrow(/--to/);
  });
});

describe('parseRenderArgs', () => {
  it('takes a match with the defaults: square, whole match, speed 1', () => {
    expect(parseRenderArgs(['--', 'fighter/abc-1'])).toEqual({
      target: { kind: 'match', ref: 'fighter/abc-1' },
      size: { width: 1080, height: 1080 },
      from: null,
      to: null,
      out: null,
      speed: 1,
      fixture: false,
    });
  });

  it('reads every flag', () => {
    const a = parseRenderArgs([
      'results/x.jsonl',
      '--size',
      '1920x1080',
      '--from',
      '2s',
      '--to',
      '900',
      '--out',
      'renders/x.mp4',
      '--speed',
      '2',
    ]);
    expect(a).toEqual({
      target: { kind: 'match', ref: 'results/x.jsonl' },
      size: { width: 1920, height: 1080 },
      from: { seconds: 2 },
      to: { frame: 900 },
      out: 'renders/x.mp4',
      speed: 2,
      fixture: false,
    });
  });

  it('takes a card, with --fixture', () => {
    expect(parseRenderArgs(['--card', 'outro', '--fixture'])).toMatchObject({
      target: { kind: 'card', name: 'outro' },
      fixture: true,
    });
  });

  it('refuses bad input with a usage error', () => {
    const bad: string[][] = [
      [],
      ['a.jsonl', 'b.jsonl'],
      ['a.jsonl', '--card', 'intro'],
      ['--card', ''],
      ['a.jsonl', '--size', '1080x1081'],
      ['a.jsonl', '--speed', '0'],
      ['a.jsonl', '--speed', 'fast'],
      ['a.jsonl', '--from', 'soon'],
      ['a.jsonl', '--fixture'],
      ['a.jsonl', '--bogus'],
    ];
    for (const argv of bad) expect(() => parseRenderArgs(argv), argv.join(' ')).toThrow(UsageError);
  });
});

describe('frameRange', () => {
  it('defaults to the whole clip and clamps --to to its end', () => {
    expect(frameRange(600, null, null)).toEqual({ from: 0, to: 600 });
    expect(frameRange(600, { seconds: 2 }, { seconds: 5 })).toEqual({ from: 120, to: 300 });
    expect(frameRange(600, { frame: 100 }, { frame: 9999 })).toEqual({ from: 100, to: 600 });
  });

  it('refuses an empty range or a start past the end', () => {
    expect(() => frameRange(600, { frame: 600 }, null)).toThrow(/past the end/);
    expect(() => frameRange(600, { frame: 300 }, { frame: 300 })).toThrow(/after --from/);
    expect(() => frameRange(600, { frame: 300 }, { frame: 10 })).toThrow(UsageError);
  });
});

describe('sourceFrames', () => {
  it('maps each 60 fps output frame to a source frame at the speed', () => {
    expect(sourceFrames({ from: 10, to: 15 }, 1)).toEqual([10, 11, 12, 13, 14]);
    expect(sourceFrames({ from: 0, to: 10 }, 2)).toEqual([0, 2, 4, 6, 8]);
    expect(sourceFrames({ from: 0, to: 3 }, 0.5)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(sourceFrames({ from: 0, to: 7 }, 3)).toEqual([0, 3, 6]);
    expect(sourceFrames({ from: 4, to: 5 }, 4)).toEqual([4]);
  });
});

describe('defaultOutPath', () => {
  it('names the file after the game, match and size, or the card and size', () => {
    expect(
      defaultOutPath({ kind: 'match', game: 'inbox', id: 'abc-1' }, { width: 1080, height: 1080 }),
    ).toBe('renders/inbox-abc-1-1080x1080.mp4');
    expect(defaultOutPath({ kind: 'card', name: 'outro' }, { width: 1920, height: 1080 })).toBe(
      'renders/card-outro-1920x1080.mp4',
    );
  });
});
