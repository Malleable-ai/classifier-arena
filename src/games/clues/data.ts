import boardsFile from '../../../data/clues/boards.json' with { type: 'json' };
import type { CluesBoard, CluesBoardsFile } from './data-build.js';

/**
 * The committed Clue Clash boards (`data/clues/boards.json`, built by `pnpm data:clues` from Open
 * English Wordnet 2025, CC BY 4.0; see data/NOTICE.md). Loaded once; never mutated.
 */
const file = boardsFile as unknown as CluesBoardsFile;

export const CLUES_BOARDS: readonly CluesBoard[] = file.boards;

/** The build's sha256 over the boards, logged with every match so a log names its data. */
export const CLUES_BOARDS_SHA256: string = file.build.sha256;

/** The board at `index` in `CLUES_BOARDS`. Throws when there is none. */
export function boardAt(index: number): CluesBoard {
  const board = CLUES_BOARDS[index];
  if (board === undefined) throw new RangeError(`no clue board at index ${String(index)}`);
  return board;
}
