import type { ResultsIndexEntry } from '../../core/replay/results-index.js';
import { SQUARE, WIDE, type RenderSize } from '../../web/shell/render-layout.js';
import { FPS } from './args.js';
import type { Window } from './segments.js';

/**
 * What `pnpm cut` puts in each cut (docs/architecture/core.md), as pure data: which match stands
 * for each game, and the order of cards and segments. intro → (title-<game> → segment) per game →
 * outro.
 */

export type CutKind = 'square' | 'wide';

export interface CutSpec {
  kind: CutKind;
  size: RenderSize;
  /** A real-time game's segment length. */
  segmentS: number;
  /** A turn game's segment holds whole turns up to this long. */
  turnMaxS: number;
  /** Output, relative to the repo root. */
  out: string;
}

/**
 * Square: 45–60 s in all (4 + 3 × (1.5 + ~13) + 7.5). Wide: the fuller cut, ~26 s per game. Each
 * segment is the end of its match (segments.ts), the result banner included.
 */
export const CUT_SPECS: Readonly<Record<CutKind, CutSpec>> = {
  square: {
    kind: 'square',
    size: SQUARE,
    segmentS: 13,
    turnMaxS: 14,
    out: 'renders/arena-square.mp4',
  },
  wide: { kind: 'wide', size: WIDE, segmentS: 26, turnMaxS: 28, out: 'renders/arena-wide.mp4' },
};

export type MatchWhy = 'featured' | 'head-to-head' | 'any';

export interface MatchChoice {
  id: string;
  why: MatchWhy;
}

/**
 * The match a game's segment comes from: its featured match (results/featured.json) if that log
 * exists; else its first valid head-to-head in the index (two different non-baseline players);
 * else, for development before any published run, its first committed log. Null when the game
 * has no logs.
 */
export function chooseMatch(
  game: string,
  baselineIds: ReadonlySet<string>,
  featured: Readonly<Record<string, string>>,
  index: readonly ResultsIndexEntry[],
  committedIds: readonly string[],
): MatchChoice | null {
  const ids = new Set(committedIds);
  const f = featured[game];
  if (f !== undefined && ids.has(f)) return { id: f, why: 'featured' };
  const h2h = index
    .filter(
      (e) =>
        e.game === game &&
        e.valid &&
        ids.has(e.id) &&
        e.players[0] !== e.players[1] &&
        e.players.every((p) => !baselineIds.has(p)),
    )
    .map((e) => e.id)
    .sort();
  const first = h2h[0];
  if (first !== undefined) return { id: first, why: 'head-to-head' };
  const any = [...committedIds].sort()[0];
  return any === undefined ? null : { id: any, why: 'any' };
}

export type CutPiece =
  | { kind: 'card'; name: string; frames: number }
  | { kind: 'match'; game: string; id: string; why: MatchWhy; window: Window };

export interface GameSegment {
  game: string;
  choice: MatchChoice;
  window: Window;
}

/** intro → (title-<game> → its segment) per game → outro. */
export function cutPieces(
  segments: readonly GameSegment[],
  cardFrames: (name: string) => number,
): CutPiece[] {
  const card = (name: string): CutPiece => ({ kind: 'card', name, frames: cardFrames(name) });
  return [
    card('intro'),
    ...segments.flatMap((s): CutPiece[] => [
      card(`title-${s.game}`),
      { kind: 'match', game: s.game, id: s.choice.id, why: s.choice.why, window: s.window },
    ]),
    card('outro'),
  ];
}

export function pieceFrames(p: CutPiece): number {
  return p.kind === 'card' ? p.frames : p.window.to - p.window.from;
}

/** The cut's length in seconds. */
export function cutSeconds(pieces: readonly CutPiece[]): number {
  return pieces.reduce((n, p) => n + pieceFrames(p), 0) / FPS;
}
