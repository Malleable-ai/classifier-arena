import { parseArgs } from 'node:util';
import {
  formatRenderSize,
  parseRenderSize,
  SQUARE,
  type RenderSize,
} from '../../web/shell/render-layout.js';

/**
 * `pnpm render`'s arguments and frame ranges (docs/architecture/core.md). Pure, so tests pin the
 * parsing.
 *
 *   pnpm render <match.jsonl | game/id> [--size 1080x1080|1920x1080] [--from <frame|Ns>]
 *               [--to <frame|Ns>] [--out <path>] [--speed 1]
 *   pnpm render --card <name> [--size …] [--out <path>] [--fixture]
 *
 * `--from` is the first frame rendered and `--to` the frame it stops before (so `--from 2s --to
 * 12s` is 10 s of video). A bare number is a frame (60 per second), `Ns` is seconds.
 */

export const FPS = 60;

export const RENDER_USAGE = [
  'usage: pnpm render <match.jsonl | game/id> [--size 1080x1080|1920x1080] [--from <frame|Ns>]',
  '                   [--to <frame|Ns>] [--out <path>] [--speed 1]',
  '       pnpm render --card <name> [--size …] [--out <path>] [--fixture]',
  '  --from/--to: a frame number (60 per second) or seconds ("2.5s"); --to is exclusive.',
  '  --speed: playback speed (2 = twice as fast); the video is always 60 fps.',
  '  cards: intro, title-fighter, title-inbox, title-clues, outro (--fixture: fake results).',
].join('\n');

export class UsageError extends Error {}

/** A frame number, or seconds to turn into one. */
export type FrameSpec = { frame: number } | { seconds: number };

/** "120" → frame 120; "2s" / "2.5s" → 2.5 seconds. Throws a UsageError otherwise. */
export function parseFrameSpec(text: string, flag = 'frame'): FrameSpec {
  const t = text.trim();
  if (/^\d+$/.test(t)) return { frame: Number(t) };
  const m = /^(\d+(?:\.\d+)?)s$/.exec(t);
  if (m !== null) return { seconds: Number(m[1]) };
  throw new UsageError(`--${flag} must be a frame number or seconds like "2.5s", got "${text}"`);
}

/** The frame a spec names (seconds round to the nearest frame). */
export function frameOf(spec: FrameSpec): number {
  return 'frame' in spec ? spec.frame : Math.round(spec.seconds * FPS);
}

export type RenderTarget = { kind: 'match'; ref: string } | { kind: 'card'; name: string };

export interface RenderArgs {
  target: RenderTarget;
  size: RenderSize;
  from: FrameSpec | null;
  to: FrameSpec | null;
  out: string | null;
  speed: number;
  /** Cards: render the outro from the dev fixture's fake results. */
  fixture: boolean;
}

export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        size: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        out: { type: 'string' },
        speed: { type: 'string' },
        card: { type: 'string' },
        fixture: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;

  const size = values.size === undefined ? { ...SQUARE } : parseRenderSize(values.size);
  if (size === null) {
    throw new UsageError(
      `--size must be <width>x<height> with even sides, e.g. 1080x1080 or 1920x1080, got "${values.size ?? ''}"`,
    );
  }
  const speed = values.speed === undefined ? 1 : Number(values.speed);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 16) {
    throw new UsageError(
      `--speed must be a number above 0 (at most 16), got "${values.speed ?? ''}"`,
    );
  }

  let target: RenderTarget;
  if (values.card !== undefined) {
    if (positionals.length > 0) throw new UsageError('give a match or --card, not both');
    if (values.card.trim() === '') throw new UsageError('--card needs a card name');
    target = { kind: 'card', name: values.card.trim() };
  } else {
    if (positionals.length !== 1) {
      throw new UsageError('give exactly one match: a .jsonl path or <game>/<match id>');
    }
    target = { kind: 'match', ref: positionals[0] ?? '' };
  }
  if (values.fixture === true && target.kind !== 'card') {
    throw new UsageError('--fixture only applies to cards (--card outro)');
  }

  return {
    target,
    size,
    from: values.from === undefined ? null : parseFrameSpec(values.from, 'from'),
    to: values.to === undefined ? null : parseFrameSpec(values.to, 'to'),
    out: values.out ?? null,
    speed,
    fixture: values.fixture === true,
  };
}

/**
 * The frames [from, to) to render out of `total`: defaults are the whole clip, `to` clamps to the
 * end. Throws a UsageError for an empty or out-of-range range.
 */
export function frameRange(
  total: number,
  from: FrameSpec | null,
  to: FrameSpec | null,
): { from: number; to: number } {
  const f = from === null ? 0 : frameOf(from);
  const t = to === null ? total : Math.min(total, frameOf(to));
  if (f >= total) {
    throw new UsageError(`--from ${String(f)} is past the end (${String(total)} frames)`);
  }
  if (t <= f) throw new UsageError(`--to must come after --from (got ${String(f)}–${String(t)})`);
  return { from: f, to: t };
}

/**
 * The source frame for each output frame, at `speed` (2 skips every other frame, 0.5 shows each
 * twice). The output is always 60 fps.
 */
export function sourceFrames(range: { from: number; to: number }, speed: number): number[] {
  const n = Math.max(1, Math.ceil((range.to - range.from) / speed - 1e-9));
  return Array.from({ length: n }, (_, k) =>
    Math.min(range.to - 1, range.from + Math.floor(k * speed + 1e-9)),
  );
}

/** `renders/<game>-<id>-<size>.mp4` for a match, `renders/card-<name>-<size>.mp4` for a card. */
export function defaultOutPath(
  target: { kind: 'match'; game: string; id: string } | { kind: 'card'; name: string },
  size: RenderSize,
): string {
  const s = formatRenderSize(size);
  return target.kind === 'card'
    ? `renders/card-${target.name}-${s}.mp4`
    : `renders/${target.game}-${target.id}-${s}.mp4`;
}
