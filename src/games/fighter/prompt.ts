import type { GamePromptConfig } from '../../core/game.js';
import type { MoveId } from './engine/types.js';
import { MOVE_IDS } from './engine/types.js';

/**
 * The fighter's frozen prompt config (docs/architecture/fighter.md): primer, option text and the
 * state format. Its hash (`promptConfigHash(FIGHTER_PROMPT_CONFIG)`, src/core/classifier/prompt.ts)
 * goes in every match header, and test/games/fighter/question.test.ts pins it. Wording is the text the spike
 * sent (test/fixtures/jev/choice-ok.request.json), so the conformance fixtures stay valid. The
 * option-order rule is not part of it: it is core's (OPTION_ORDER_RULE), logged in every header.
 * Never tune this for one model (RULES.md).
 */

const PRIMER =
  'You control a fighter in a one-on-one 2D fighting game. The state is from your point of view ' +
  '("you" and "opponent"). Pick the move that gives you the best outcome right now. Rules: ' +
  'health starts at 100 and the round goes to whoever has more health when the clock runs out. ' +
  'Ranges: close is under 120 units, mid is 120-350, far is over 350. The right block stops ' +
  'strikes; a throw beats a block; an uppercut beats a jump-in; a sweep beats block_high; a ' +
  'jump-in beats block_low; jumping over a fireball beats it. Every whiffed move leaves a gap ' +
  'the opponent can punish. busy_ticks above 0 means that fighter cannot act yet. ' +
  'opponent_fireball is null when there is none; ticks_to_hit says how soon it arrives.';

const DESCRIPTIONS: Readonly<Record<MoveId, string>> = {
  walk_forward:
    'Walk toward the opponent to close distance. Beats nothing directly; loses to any strike or fireball that reaches you.',
  walk_back:
    'Walk away to make space; does not block. Beats short-range moves by staying out of reach; loses to fireball and jump_in.',
  block_high:
    'Hold a high block: stops jab, heavy_punch, jump_in and fireball. Loses to sweep and throw.',
  block_low:
    'Hold a low block: stops jab, heavy_punch, sweep and fireball. Loses to jump_in and throw.',
  jab: 'Fast short-range punch, 4 damage, little recovery. Beats a slower move at close range; loses to blocks and longer-range moves.',
  heavy_punch:
    'Slower punch with longer reach, 9 damage, pushes back on hit. Beats walk_forward at mid range; loses to blocks and faster jabs.',
  sweep:
    'Low kick that knocks down, 7 damage. Beats block_high and standing opponents; loses to block_low and jump_in.',
  fireball:
    'Projectile, 6 damage, 1 chip on block, needs fireball_ready. Beats walking and far-range waiting; loses to jump_in over it and blocks; cancels the opponent fireball.',
  uppercut:
    'Anti-air, 10 damage, briefly invincible, long recovery. Beats jump_in; loses badly if it misses.',
  throw:
    'Very short-range grab, 10 damage, cannot be blocked. Beats block_high and block_low at close range; loses to airborne opponents and active strikes.',
  jump_in:
    'Forward jump with an overhead kick, 8 damage; jumps over fireballs. Beats block_low and fireball; loses to uppercut and block_high.',
};

export const FIGHTER_PROMPT_CONFIG = {
  // v2: the prompt text (primer and option descriptions) is unchanged from v1. v2 only dropped the
  // option-order rule, which moved to core (OPTION_ORDER_RULE, logged in every header). Dropping it
  // changed the hash, so the version moved too: v1 hashed to 9553e0fcba75ec7d, v2 to
  // d7ce85c39c9adebe.
  version: 2,
  questionName: 'next_move',
  primer: PRIMER,
  /** In canonical (MOVE_IDS) order; the scheduler orders them per match (core order rule). */
  options: MOVE_IDS.map((id) => ({ id, description: DESCRIPTIONS[id] })),
  stateFormatVersion: 2,
} as const satisfies GamePromptConfig;
