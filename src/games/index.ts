import type { Game } from '../core/game.js';
import { cluesGame } from './clues/game.js';
import { fighterGame } from './fighter/game.js';
import { inboxGame } from './inbox/game.js';

/**
 * Every playable game: the fighter, Inbox Invaders and Clue Clash. Test-only games
 * (test/core/games/) are never registered here.
 */
export const GAMES: readonly Game[] = [fighterGame, inboxGame, cluesGame];

export function getGame(id: string): Game {
  const game = GAMES.find((g) => g.id === id);
  if (!game) throw new Error(`unknown game "${id}"`);
  return game;
}

export function gameIds(): string[] {
  return GAMES.map((g) => g.id);
}
