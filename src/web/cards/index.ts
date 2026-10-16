import type { Leaderboard } from '../../core/stats/leaderboard.js';
import type { RenderSize } from '../shell/render-layout.js';
import { drawIntro, drawOutro, drawTitle } from './draw.js';
import { introTeaser } from './intro-model.js';
import { outroModel } from './outro-model.js';
import { CARD_FRAMES } from './timeline.js';

/**
 * The video's cards (docs/architecture/core.md, "Video cards"): `intro`, `title-<game>` for each
 * game, and `outro`; the intro's result teaser and the outro are built from
 * `results/leaderboard.json` when they render. Each is a deterministic canvas animation (a frame
 * is a pure function of the frame index and the data) with on-screen captions and no audio,
 * rendered by the same pipeline as matches: `/?card=<name>&render=1&size=…` and
 * `pnpm render --card <name>`.
 */

export interface Card {
  name: string;
  /** Length in frames at 60 fps. */
  frames: number;
  /** Draw frame `frame` (0 … frames − 1) over the whole canvas of `size`. */
  draw(ctx: CanvasRenderingContext2D, frame: number, size: RenderSize): void;
}

export interface CardData {
  /** `results/leaderboard.json` (or the dev fixture's), null when there is none. */
  leaderboard: Leaderboard | null;
  /** Every registered game in registry order: the title cards and the outro's rows. */
  games: readonly { id: string; label: string }[];
}

/** The decision each game asks for, one line for its title card. */
export const GAME_DESCRIPTIONS: Readonly<Record<string, string>> = {
  fighter: 'Real time: pick the next move of 11, again and again, as the fight unfolds',
  inbox: 'Real time: label each falling text legit, spam or smishing before it lands',
  clues: 'Turns: read a definition and pick its word from 16 close ones',
};

export const TITLE_PREFIX = 'title-';

/** Every card name for these games, in the order the cut plays them (titles in game order). */
export function cardNames(gameIds: readonly string[]): string[] {
  return ['intro', ...gameIds.map((id) => `${TITLE_PREFIX}${id}`), 'outro'];
}

export function cardFor(name: string, data: CardData): Card | null {
  if (name === 'intro') {
    const teaser = introTeaser(data.leaderboard);
    return {
      name,
      frames: CARD_FRAMES.intro,
      draw: (ctx, frame, size) => {
        drawIntro(ctx, size, frame, teaser);
      },
    };
  }
  if (name === 'outro') {
    const model = outroModel(data.leaderboard, data.games);
    return {
      name,
      frames: CARD_FRAMES.outro,
      draw: (ctx, frame, size) => {
        drawOutro(ctx, size, frame, model);
      },
    };
  }
  if (name.startsWith(TITLE_PREFIX)) {
    const id = name.slice(TITLE_PREFIX.length);
    const index = data.games.findIndex((g) => g.id === id);
    const game = data.games[index];
    if (game === undefined) return null;
    const title = {
      label: game.label,
      description: GAME_DESCRIPTIONS[id] ?? '',
      position: index + 1,
      count: data.games.length,
    };
    return {
      name,
      frames: CARD_FRAMES.title,
      draw: (ctx, frame, size) => {
        drawTitle(ctx, size, frame, title);
      },
    };
  }
  return null;
}
